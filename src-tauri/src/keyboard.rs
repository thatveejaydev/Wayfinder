use std::mem::size_of;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
};

pub(super) fn send_shortcut(modifier: VIRTUAL_KEY, key: VIRTUAL_KEY) -> bool {
    let inputs = [
        (modifier, false),
        (key, false),
        (key, true),
        (modifier, true),
    ]
    .map(|(key, released)| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if released {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    });
    (unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) }) as usize == inputs.len()
}
