use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::CONTENT_TYPE, Client, Response};
use std::{sync::OnceLock, time::Duration};
use url::Url;

const MAX_ICON_BYTES: usize = 256 * 1024;

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
    let url = Url::parse(path).ok()?;
    // Use the site's origin so saved query strings and credentials stay out of icon requests.
    let mut page = Url::parse(&url.origin().ascii_serialization()).ok()?;
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
            return Some(icon);
        }
    }
    None
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

    // The Windows Shell icon lookup requires backslashes, including for saved Start Menu links.
    let path: Vec<u16> = path
        .replace('/', "\\")
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
                PCWSTR(path.as_ptr()),
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
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder
        .write_header()
        .ok()?
        .write_image_data(&pixels)
        .ok()?;
    Some(data_url("image/png", &png))
}
