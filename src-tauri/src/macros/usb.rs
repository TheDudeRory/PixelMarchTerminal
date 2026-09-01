#[derive(Debug, Clone, PartialEq)]
pub struct UsbDevice {
    pub vid: u16,
    pub pid: u16,
    pub name: String,
    pub instance_id: String,
}

pub trait UsbEnumerator: Send + Sync {
    fn list(&self) -> Result<Vec<UsbDevice>, String>;
}

/// Query is either "VID:PID" hex ("046D:C52B") or a name substring.
pub fn usb_matches(dev: &UsbDevice, query: &str) -> bool {
    if let Some((vid, pid)) = parse_vid_pid_query(query) {
        return dev.vid == vid && dev.pid == pid;
    }
    let q = query.trim().to_lowercase();
    !q.is_empty()
        && (dev.name.to_lowercase().contains(&q) || dev.instance_id.to_lowercase().contains(&q))
}

pub fn any_connected(devices: &[UsbDevice], query: &str) -> bool {
    devices.iter().any(|d| usb_matches(d, query))
}

fn parse_vid_pid_query(query: &str) -> Option<(u16, u16)> {
    let (v, p) = query.trim().split_once(':')?;
    Some((u16::from_str_radix(v.trim(), 16).ok()?, u16::from_str_radix(p.trim(), 16).ok()?))
}

/// "USB\VID_046D&PID_C52B\..." → (0x046D, 0xC52B); 0 when absent (hubs etc).
pub fn parse_instance_vid_pid(instance_id: &str) -> (u16, u16) {
    let upper = instance_id.to_uppercase();
    let grab = |tag: &str| {
        upper
            .find(tag)
            .and_then(|i| upper.get(i + tag.len()..i + tag.len() + 4))
            .and_then(|h| u16::from_str_radix(h, 16).ok())
            .unwrap_or(0)
    };
    (grab("VID_"), grab("PID_"))
}

#[cfg(windows)]
pub use win_impl::NativeUsbEnumerator;
#[cfg(not(windows))]
pub use sysfs_impl::NativeUsbEnumerator;

#[cfg(windows)]
mod win_impl {
    use super::{parse_instance_vid_pid, UsbDevice, UsbEnumerator};
    use windows::core::w;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES,
        DIGCF_PRESENT, HDEVINFO, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME, SP_DEVINFO_DATA,
    };

    pub struct NativeUsbEnumerator;

    unsafe fn reg_string(
        set: HDEVINFO,
        info: &SP_DEVINFO_DATA,
        prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY,
    ) -> Option<String> {
        let mut buf = [0u8; 1024];
        let mut required = 0u32;
        unsafe {
            SetupDiGetDeviceRegistryPropertyW(
                set,
                info,
                prop,
                None,
                Some(&mut buf),
                Some(&mut required),
            )
            .ok()?;
        }
        let words: Vec<u16> = buf[..required as usize]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&w| w != 0)
            .collect();
        Some(String::from_utf16_lossy(&words))
    }

    impl UsbEnumerator for NativeUsbEnumerator {
        fn list(&self) -> Result<Vec<UsbDevice>, String> {
            unsafe {
                let set = SetupDiGetClassDevsW(None, w!("USB"), None, DIGCF_PRESENT | DIGCF_ALLCLASSES)
                    .map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                let mut index = 0;
                loop {
                    let mut info = SP_DEVINFO_DATA {
                        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                        ..Default::default()
                    };
                    if SetupDiEnumDeviceInfo(set, index, &mut info).is_err() {
                        break;
                    }
                    index += 1;
                    let mut buf = [0u16; 512];
                    let mut required = 0u32;
                    if SetupDiGetDeviceInstanceIdW(set, &info, Some(&mut buf), Some(&mut required))
                        .is_err()
                    {
                        continue;
                    }
                    let instance_id = String::from_utf16_lossy(
                        &buf[..(required.saturating_sub(1)) as usize],
                    );
                    let (vid, pid) = parse_instance_vid_pid(&instance_id);
                    let name = reg_string(set, &info, SPDRP_FRIENDLYNAME)
                        .or_else(|| reg_string(set, &info, SPDRP_DEVICEDESC))
                        .unwrap_or_default();
                    out.push(UsbDevice { vid, pid, name, instance_id });
                }
                let _ = SetupDiDestroyDeviceInfoList(set);
                Ok(out)
            }
        }
    }
}

/// ponytail: untested-on-this-box sysfs walk; verify when a Linux session exists.
#[cfg(not(windows))]
mod sysfs_impl {
    use super::{UsbDevice, UsbEnumerator};

    pub struct NativeUsbEnumerator;

    impl UsbEnumerator for NativeUsbEnumerator {
        fn list(&self) -> Result<Vec<UsbDevice>, String> {
            let read = |p: std::path::PathBuf| std::fs::read_to_string(p).unwrap_or_default();
            let dir = std::fs::read_dir("/sys/bus/usb/devices").map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for entry in dir.flatten() {
                let path = entry.path();
                let vid = u16::from_str_radix(read(path.join("idVendor")).trim(), 16).unwrap_or(0);
                let pid = u16::from_str_radix(read(path.join("idProduct")).trim(), 16).unwrap_or(0);
                if vid == 0 && pid == 0 {
                    continue;
                }
                let name = format!(
                    "{} {}",
                    read(path.join("manufacturer")).trim(),
                    read(path.join("product")).trim()
                )
                .trim()
                .to_string();
                out.push(UsbDevice {
                    vid,
                    pid,
                    name,
                    instance_id: entry.file_name().to_string_lossy().into_owned(),
                });
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_id_parsing() {
        assert_eq!(parse_instance_vid_pid(r"USB\VID_046D&PID_C52B\6&2E1"), (0x046D, 0xC52B));
        assert_eq!(parse_instance_vid_pid(r"USB\ROOT_HUB30\5&33"), (0, 0));
    }

    #[test]
    fn query_matching() {
        let dev = UsbDevice {
            vid: 0x046D,
            pid: 0xC52B,
            name: "Logitech USB Receiver".into(),
            instance_id: r"USB\VID_046D&PID_C52B\6".into(),
        };
        assert!(usb_matches(&dev, "046d:c52b"));
        assert!(usb_matches(&dev, "046D:C52B"));
        assert!(!usb_matches(&dev, "046d:0000"));
        assert!(usb_matches(&dev, "logitech"));
        assert!(usb_matches(&dev, "vid_046d"));
        assert!(!usb_matches(&dev, "razer"));
        assert!(!usb_matches(&dev, ""));
    }
}
