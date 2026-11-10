use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::CONTENT_TYPE, Client, Response};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    time::{Duration, UNIX_EPOCH},
};
use url::Url;

const MAX_ICON_BYTES: usize = 256 * 1024;
const MAX_THUMBNAIL_EDGE: u32 = 96;
const DIRECT_PREVIEW_MAX_BYTES: u64 = 24 * 1024;

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static MEMORY_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn init(cache_dir: PathBuf) {
    let _ = CACHE_DIR.set(cache_dir);
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn cache_file_path(key: &str) -> Option<PathBuf> {
    Some(CACHE_DIR.get()?.join(format!("{:016x}.cache", fnv1a64(key.as_bytes()))))
}

fn load_cached(key: &str) -> Option<String> {
    if let Ok(cache) = MEMORY_CACHE.lock() {
        if let Some(value) = cache.get(key) {
            return Some(value.clone());
        }
    }
    let path = cache_file_path(key)?;
    let cached = fs::read_to_string(path).ok()?;
    if !cached.starts_with("data:image/") {
        return None;
    }
    if let Ok(mut cache) = MEMORY_CACHE.lock() {
        cache.insert(key.to_string(), cached.clone());
    }
    Some(cached)
}

fn store_cached(key: &str, value: &str) {
    if let Ok(mut cache) = MEMORY_CACHE.lock() {
        cache.insert(key.to_string(), value.to_string());
    }
    if let Some(path) = cache_file_path(key) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, value);
    }
}

fn file_stamp(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis())
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

fn website_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

fn declared_icons(page: &Url, html: &str) -> Vec<Url> {
    let document = dom_query::Document::from(html);
    let base = document
        .select_single("head base[href]")
        .attr("href")
        .and_then(|href| page.join(href.trim()).ok())
        .filter(website_url);
    let mut icons = Vec::new();
    for selector in [
        "head link[rel~='icon' i][href]",
        "head link[rel~='apple-touch-icon' i][href]",
    ] {
        for link in document.select(selector).nodes().iter().rev() {
            let Some(url) = link
                .attr("href")
                .filter(|href| !href.trim().is_empty())
                .and_then(|href| base.as_ref().unwrap_or(page).join(href.trim()).ok())
                .filter(website_url)
            else {
                continue;
            };
            if !icons.contains(&url) {
                icons.push(url);
            }
            if icons.len() == 3 {
                return icons;
            }
        }
    }
    icons
}

async fn response_prefix(response: &mut Response) -> Option<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        let remaining = MAX_ICON_BYTES - bytes.len();
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Some((bytes, false));
        }
        bytes.extend_from_slice(&chunk);
    }
    Some((bytes, true))
}

async fn download_icon(client: &Client, url: Url) -> Option<String> {
    let mut response = client.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_ICON_BYTES as u64)
    {
        return None;
    }
    let (bytes, complete) = response_prefix(&mut response).await?;
    if !complete || bytes.is_empty() {
        return None;
    }
    let mime = match bytes.as_slice() {
        [0, 0, 1, 0, ..] => "image/x-icon",
        [137, 80, 78, 71, 13, 10, 26, 10, ..] => "image/png",
        _ => response
            .headers()
            .get(CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()?
            .trim(),
    };
    matches!(
        mime,
        "image/x-icon"
            | "image/vnd.microsoft.icon"
            | "image/png"
            | "image/svg+xml"
            | "image/webp"
            | "image/jpeg"
            | "image/gif"
            | "image/avif"
            | "image/bmp"
    )
    .then(|| data_url(mime, &bytes))
}

pub(crate) async fn site_icon(path: &str) -> Option<String> {
    let url = Url::parse(path).ok()?;
    let origin = url.origin().ascii_serialization();
    let cache_key = format!("web:{origin}");
    if let Some(cached) = load_cached(&cache_key) {
        return Some(cached);
    }
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(Duration::from_secs(4))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 || !website_url(attempt.url()) {
                        return attempt.stop();
                    }
                    attempt.follow()
                }))
                .build()
                .ok()
        })
        .as_ref()?;
    // Use the site's origin so saved query strings and credentials stay out of icon requests.
    let mut page = Url::parse(&origin).ok()?;
    if !website_url(&page) {
        return None;
    }
    let mut candidates = Vec::new();
    if let Ok(mut response) = client.get(page.clone()).send().await {
        page = response.url().clone();
        if response.status().is_success() {
            if let Some((html, _)) = response_prefix(&mut response).await {
                candidates = declared_icons(&page, &String::from_utf8_lossy(&html));
            }
        }
    }
    let default_icon = page.join("/favicon.ico").ok().filter(website_url)?;
    if !candidates.contains(&default_icon) {
        candidates.push(default_icon);
    }
    for candidate in candidates {
        if let Some(icon) = download_icon(client, candidate).await {
            store_cached(&cache_key, &icon);
            return Some(icon);
        }
    }
    None
}

fn encode_rgba_png(width: u32, height: u32, pixels: &[u8]) -> Option<String> {
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder
        .write_header()
        .ok()?
        .write_image_data(pixels)
        .ok()?;
    Some(data_url("image/png", &png))
}

#[cfg(windows)]
fn scaled_wic_thumbnail(path: &Path) -> Option<String> {
    use std::ptr::null;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::GENERIC_READ,
            Graphics::Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
                WICBitmapInterpolationModeFant, WICConvertBitmapSource,
                WICDecodeMetadataCacheOnDemand,
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
        },
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    use std::os::windows::ffi::OsStrExt;
    let (width, height, pixels) = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()?;
        let result = (|| {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let decoder = factory
                .CreateDecoderFromFilename(
                    PCWSTR(wide.as_ptr()),
                    None,
                    GENERIC_READ,
                    WICDecodeMetadataCacheOnDemand,
                )
                .ok()?;
            let frame = decoder.GetFrame(0).ok()?;
            let (mut src_w, mut src_h) = (0, 0);
            frame.GetSize(&mut src_w, &mut src_h).ok()?;
            if src_w == 0 || src_h == 0 {
                return None;
            }
            let max_dim = src_w.max(src_h);
            let (dst_w, dst_h) = if max_dim > MAX_THUMBNAIL_EDGE {
                (
                    ((u64::from(src_w) * u64::from(MAX_THUMBNAIL_EDGE)) / u64::from(max_dim)).max(1)
                        as u32,
                    ((u64::from(src_h) * u64::from(MAX_THUMBNAIL_EDGE)) / u64::from(max_dim)).max(1)
                        as u32,
                )
            } else {
                (src_w, src_h)
            };
            let scaler = factory.CreateBitmapScaler().ok()?;
            scaler
                .Initialize(&frame, dst_w, dst_h, WICBitmapInterpolationModeFant)
                .ok()?;
            let converted = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &scaler).ok()?;
            let mut pixels = vec![0; (dst_w * dst_h * 4) as usize];
            converted.CopyPixels(null(), dst_w * 4, &mut pixels).ok()?;
            Some((dst_w, dst_h, pixels))
        })();
        CoUninitialize();
        result?
    };
    encode_rgba_png(width, height, &pixels)
}

pub(crate) fn image_preview(path: &Path, metadata: &fs::Metadata, max_bytes: u64) -> Option<String> {
    if metadata.len() > max_bytes {
        return None;
    }
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    let cache_key = format!(
        "img:{}:{}:{}",
        path.to_string_lossy().to_ascii_lowercase(),
        file_stamp(metadata),
        metadata.len()
    );
    if let Some(cached) = load_cached(&cache_key) {
        return Some(cached);
    }
    #[cfg(windows)]
    if ext != "gif" && metadata.len() > DIRECT_PREVIEW_MAX_BYTES {
        if let Some(thumb) = scaled_wic_thumbnail(path) {
            store_cached(&cache_key, &thumb);
            return Some(thumb);
        }
    }
    let bytes = fs::read(path).ok()?;
    let encoded = data_url(mime, &bytes);
    store_cached(&cache_key, &encoded);
    Some(encoded)
}

#[cfg(windows)]
pub(crate) fn app_icon(path: &str) -> Option<String> {
    use std::ptr::null;
    use windows::{
        core::PCWSTR,
        Win32::{
            Graphics::Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
                WICConvertBitmapSource,
            },
            Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::{
                Controls::{ImageList_GetIcon, HIMAGELIST, ILD_NORMAL},
                Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_LARGEICON, SHGFI_SYSICONINDEX},
                WindowsAndMessaging::DestroyIcon,
            },
        },
    };

    let normalized_path = path.replace('/', "\\");
    let cache_key = match fs::metadata(&normalized_path) {
        Ok(meta) => format!(
            "app:{}:{}:{}",
            normalized_path.to_ascii_lowercase(),
            file_stamp(&meta),
            meta.len()
        ),
        Err(_) => format!("app:{}", normalized_path.to_ascii_lowercase()),
    };
    if let Some(cached) = load_cached(&cache_key) {
        return Some(cached);
    }

    // The Windows Shell icon lookup requires backslashes, including for saved Start Menu links.
    let wide_path: Vec<u16> = normalized_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let (width, height, pixels) = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()?;
        let result = (|| {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let mut info = SHFILEINFOW::default();
            let image_list = SHGetFileInfoW(
                PCWSTR(wide_path.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut info),
                size_of::<SHFILEINFOW>() as u32,
                SHGFI_SYSICONINDEX | SHGFI_LARGEICON,
            );
            if image_list == 0 {
                return None;
            }
            // The system image list stores the base icon separately from the shortcut overlay.
            let icon = ImageList_GetIcon(HIMAGELIST(image_list as isize), info.iIcon, ILD_NORMAL);
            if icon.is_invalid() {
                return None;
            }
            let bitmap = factory.CreateBitmapFromHICON(icon);
            let _ = DestroyIcon(icon);
            let bitmap =
                WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &bitmap.ok()?).ok()?;
            let (mut width, mut height) = (0, 0);
            bitmap.GetSize(&mut width, &mut height).ok()?;
            if !(1..=256).contains(&width) || !(1..=256).contains(&height) {
                return None;
            }
            let mut pixels = vec![0; (width * height * 4) as usize];
            bitmap.CopyPixels(null(), width * 4, &mut pixels).ok()?;
            Some((width, height, pixels))
        })();
        CoUninitialize();
        result?
    };
    let encoded = encode_rgba_png(width, height, &pixels)?;
    store_cached(&cache_key, &encoded);
    Some(encoded)
}
