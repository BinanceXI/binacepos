use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(serde::Serialize)]
struct SerialPortDto {
  port_name: String,
  port_type: String,
  manufacturer: Option<String>,
  product: Option<String>,
  serial_number: Option<String>,
  vid: Option<u16>,
  pid: Option<u16>,
}

#[tauri::command]
async fn tcp_print_escpos(host: String, port: u16, data: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let addr = (host.as_str(), port)
      .to_socket_addrs()
      .map_err(|e| format!("Unable to resolve host: {e}"))?
      .next()
      .ok_or("Unable to resolve host")?;

    let timeout = Duration::from_secs(3);
    let mut stream =
      TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("TCP connect failed: {e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_nodelay(true);

    stream
      .write_all(&data)
      .map_err(|e| format!("TCP write failed: {e}"))?;
    let _ = stream.flush();

    Ok(())
  })
  .await
  .map_err(|e| format!("Print task failed: {e}"))?
}

#[tauri::command]
async fn list_serial_ports() -> Result<Vec<SerialPortDto>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut ports =
      serialport::available_ports().map_err(|e| format!("Unable to list serial ports: {e}"))?;
    ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));

    let out = ports
      .into_iter()
      .map(|p| {
        let mut dto = SerialPortDto {
          port_name: p.port_name,
          port_type: "unknown".to_string(),
          manufacturer: None,
          product: None,
          serial_number: None,
          vid: None,
          pid: None,
        };

        match p.port_type {
          serialport::SerialPortType::UsbPort(info) => {
            dto.port_type = "usb".to_string();
            dto.manufacturer = info.manufacturer;
            dto.product = info.product;
            dto.serial_number = info.serial_number;
            dto.vid = Some(info.vid);
            dto.pid = Some(info.pid);
          }
          serialport::SerialPortType::BluetoothPort => {
            dto.port_type = "bluetooth".to_string();
          }
          serialport::SerialPortType::PciPort => {
            dto.port_type = "pci".to_string();
          }
          serialport::SerialPortType::Unknown => {}
        }

        dto
      })
      .collect::<Vec<_>>();

    Ok(out)
  })
  .await
  .map_err(|e| format!("List ports task failed: {e}"))?
}

#[tauri::command]
async fn serial_print_escpos(port: String, baud: u32, data: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let port_name = port.clone();
    let mut sp = serialport::new(port, baud)
      .timeout(Duration::from_secs(3))
      .open()
      .map_err(|e| format!("Unable to open serial port {port_name}: {e}"))?;

    for chunk in data.chunks(512) {
      sp.write_all(chunk)
        .map_err(|e| format!("Serial write failed ({port_name}): {e}"))?;
      std::thread::sleep(Duration::from_millis(20));
    }

    sp.flush()
      .map_err(|e| format!("Serial flush failed ({port_name}): {e}"))?;
    Ok(())
  })
  .await
  .map_err(|e| format!("Print task failed: {e}"))?
}

#[cfg(target_os = "windows")]
mod windows_printing {
  use std::ffi::c_void;
  use std::ffi::OsStr;
  use std::iter::once;
  use std::os::windows::ffi::OsStrExt;
  use std::ptr::null_mut;

  use windows_sys::Win32::Foundation::HANDLE;
  use windows_sys::Win32::Graphics::Printing::{
    ClosePrinter, DOC_INFO_1W, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW,
    PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W, StartDocPrinterW,
    StartPagePrinter, WritePrinter,
  };

  fn to_wide(input: &str) -> Vec<u16> {
    OsStr::new(input).encode_wide().chain(once(0)).collect()
  }

  fn from_wide_ptr(ptr: *const u16) -> String {
    if ptr.is_null() {
      return String::new();
    }
    let mut len = 0usize;
    unsafe {
      while *ptr.add(len) != 0 {
        len += 1;
      }
      String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
  }

  pub fn list_windows_printers() -> Result<Vec<String>, String> {
    unsafe {
      let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
      let mut needed = 0u32;
      let mut returned = 0u32;

      EnumPrintersW(
        flags,
        null_mut(),
        4,
        null_mut(),
        0,
        &mut needed,
        &mut returned,
      );

      if needed == 0 {
        return Ok(vec![]);
      }

      let mut buffer = vec![0u8; needed as usize];
      let ok = EnumPrintersW(
        flags,
        null_mut(),
        4,
        buffer.as_mut_ptr(),
        needed,
        &mut needed,
        &mut returned,
      );
      if ok == 0 {
        return Err("Failed to enumerate windows printers".to_string());
      }

      let ptr = buffer.as_ptr() as *const PRINTER_INFO_4W;
      let mut out: Vec<String> = Vec::new();
      for i in 0..returned as usize {
        let item = *ptr.add(i);
        let name = from_wide_ptr(item.pPrinterName);
        if !name.trim().is_empty() {
          out.push(name);
        }
      }
      out.sort();
      out.dedup();
      Ok(out)
    }
  }

  pub fn spooler_print_raw(printer_name: String, data: Vec<u8>) -> Result<(), String> {
    if printer_name.trim().is_empty() {
      return Err("Printer name is required".to_string());
    }

    unsafe {
      let mut handle: HANDLE = std::ptr::null_mut();
      let mut printer_name_w = to_wide(&printer_name);
      let open_ok = OpenPrinterW(printer_name_w.as_mut_ptr(), &mut handle, null_mut());
      if open_ok == 0 || handle.is_null() {
        return Err(format!("Failed to open printer '{printer_name}'"));
      }

      let doc_name = to_wide("BinanceXI Receipt");
      let data_type = to_wide("RAW");
      let doc_info = DOC_INFO_1W {
        pDocName: doc_name.as_ptr() as *mut u16,
        pOutputFile: null_mut(),
        pDatatype: data_type.as_ptr() as *mut u16,
      };

      let job_id = StartDocPrinterW(handle, 1, &doc_info as *const DOC_INFO_1W);
      if job_id == 0 {
        ClosePrinter(handle);
        return Err("StartDocPrinter failed".to_string());
      }

      if StartPagePrinter(handle) == 0 {
        EndDocPrinter(handle);
        ClosePrinter(handle);
        return Err("StartPagePrinter failed".to_string());
      }

      let mut written = 0u32;
      let write_ok = WritePrinter(
        handle,
        data.as_ptr() as *const c_void,
        data.len() as u32,
        &mut written,
      );
      let page_ok = EndPagePrinter(handle);
      let doc_ok = EndDocPrinter(handle);
      ClosePrinter(handle);

      if write_ok == 0 || written != data.len() as u32 {
        return Err(format!(
          "WritePrinter failed (written {written}/{} bytes)",
          data.len()
        ));
      }
      if page_ok == 0 || doc_ok == 0 {
        return Err("Failed to finalize print job".to_string());
      }

      Ok(())
    }
  }
}

#[cfg(not(target_os = "windows"))]
mod windows_printing {
  pub fn list_windows_printers() -> Result<Vec<String>, String> {
    Ok(vec![])
  }

  pub fn spooler_print_raw(_printer_name: String, _data: Vec<u8>) -> Result<(), String> {
    Err("Windows spooler transport is only available on Windows builds".to_string())
  }
}

#[tauri::command]
async fn list_windows_printers() -> Result<Vec<String>, String> {
  tauri::async_runtime::spawn_blocking(windows_printing::list_windows_printers)
    .await
    .map_err(|e| format!("List printers task failed: {e}"))?
}

#[tauri::command]
async fn spooler_print_raw(printer_name: String, data: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || windows_printing::spooler_print_raw(printer_name, data))
    .await
    .map_err(|e| format!("Spooler print task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      tcp_print_escpos,
      list_serial_ports,
      serial_print_escpos,
      list_windows_printers,
      spooler_print_raw
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
