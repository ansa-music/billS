//! Silent receipt printing: prints the current page (its @media print view — only #print-root,
//! see apps/web/src/cash/print/printForm.tsx) on the chosen printer without a system dialog.

use tauri::WebviewWindow;
use tokio::sync::oneshot;

/// Paper of one receipt, mm: roll width and the measured form height.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
  pub width_mm: f64,
  pub height_mm: f64,
}

pub async fn print(window: &WebviewWindow, page: Page, printer: String) -> Result<(), String> {
  if !(page.width_mm > 0.0 && page.height_mm > 0.0) {
    return Err("Неверный размер чека".into());
  }
  let (tx, rx) = oneshot::channel::<Result<(), String>>();
  window
    .with_webview(move |webview| {
      // Runs on the UI thread; the result arrives later through `tx`.
      if let Err(e) = platform::start(webview, page, &printer, tx) {
        log::warn(&e);
      }
    })
    .map_err(|e| e.to_string())?;
  rx.await.map_err(|_| "Печать прервана".to_string())?
}

mod log {
  pub fn warn(message: &str) {
    eprintln!("[TS] печать: {message}");
  }
}

#[cfg(windows)]
mod platform {
  use super::Page;
  use tokio::sync::oneshot::Sender;
  use webview2_com::Microsoft::Web::WebView2::Win32::*;
  use webview2_com::PrintCompletedHandler;
  use windows::core::{Interface, HSTRING};

  const MM_PER_INCH: f64 = 25.4;

  pub fn start(
    webview: tauri::webview::PlatformWebview,
    page: Page,
    printer: &str,
    tx: Sender<Result<(), String>>,
  ) -> Result<(), String> {
    // `tx` must answer even when setup fails, so it is only moved into the handler at the end.
    let setup = || -> windows::core::Result<(ICoreWebView2_16, ICoreWebView2PrintSettings)> {
      unsafe {
        let core = webview.controller().CoreWebView2()?;
        let core16: ICoreWebView2_16 = core.cast()?;
        let env6: ICoreWebView2Environment6 = webview.environment().cast()?;
        let settings = env6.CreatePrintSettings()?;
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
        settings.SetPageWidth(page.width_mm / MM_PER_INCH)?;
        settings.SetPageHeight(page.height_mm / MM_PER_INCH)?;
        settings.SetMarginTop(0.0)?;
        settings.SetMarginBottom(0.0)?;
        settings.SetMarginLeft(0.0)?;
        settings.SetMarginRight(0.0)?;
        settings.SetScaleFactor(1.0)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        if !printer.is_empty() {
          let named: ICoreWebView2PrintSettings2 = settings.cast()?;
          named.SetPrinterName(&HSTRING::from(printer))?;
        }
        Ok((core16, settings))
      }
    };
    let (core16, settings) = match setup() {
      Ok(pair) => pair,
      Err(e) => {
        let message = format!("WebView2 не поддерживает тихую печать: {e}");
        let _ = tx.send(Err(message.clone()));
        return Err(message);
      }
    };
    let handler = PrintCompletedHandler::create(Box::new(move |result, status| {
      let outcome = match (result, status) {
        (Ok(()), COREWEBVIEW2_PRINT_STATUS_SUCCEEDED) => Ok(()),
        (Ok(()), COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE) => Err("Принтер недоступен".to_string()),
        (Ok(()), _) => Err("Чек не напечатан".to_string()),
        (Err(e), _) => Err(format!("Ошибка печати: {e}")),
      };
      let _ = tx.send(outcome);
      Ok(())
    }));
    unsafe { core16.Print(&settings, &handler) }.map_err(|e| format!("Ошибка печати: {e}"))
  }
}

#[cfg(target_os = "linux")]
mod platform {
  use super::Page;
  use gtk::{PageSetup, PaperSize, PrintSettings, Unit};
  use std::cell::RefCell;
  use std::rc::Rc;
  use tokio::sync::oneshot::Sender;
  use webkit2gtk::{PrintOperation, PrintOperationExt};

  pub fn start(
    webview: tauri::webview::PlatformWebview,
    page: Page,
    printer: &str,
    tx: Sender<Result<(), String>>,
  ) -> Result<(), String> {
    let paper = PaperSize::new_custom("ts-receipt", "TS", page.width_mm, page.height_mm, Unit::Mm);
    let setup = PageSetup::new();
    setup.set_paper_size(&paper);
    for set in [PageSetup::set_top_margin, PageSetup::set_bottom_margin, PageSetup::set_left_margin, PageSetup::set_right_margin] {
      set(&setup, 0.0, Unit::Mm);
    }
    let settings = PrintSettings::new();
    if !printer.is_empty() {
      settings.set_printer(printer);
    }
    let operation = PrintOperation::new(&webview.inner());
    operation.set_page_setup(&setup);
    operation.set_print_settings(&settings);

    // `failed` is followed by `finished`; whichever comes first answers.
    let tx = Rc::new(RefCell::new(Some(tx)));
    let on_failed = tx.clone();
    operation.connect_failed(move |_, error| {
      if let Some(tx) = on_failed.borrow_mut().take() {
        let _ = tx.send(Err(format!("Ошибка печати: {error}")));
      }
    });
    operation.connect_finished(move |_| {
      if let Some(tx) = tx.borrow_mut().take() {
        let _ = tx.send(Ok(()));
      }
    });
    // No dialog: prints with the settings above (empty printer — the system default).
    operation.print();
    Ok(())
  }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
  use super::Page;
  use tokio::sync::oneshot::Sender;

  pub fn start(_: tauri::webview::PlatformWebview, _: Page, _: &str, tx: Sender<Result<(), String>>) -> Result<(), String> {
    let _ = tx.send(Err("Тихая печать есть только на Windows и Linux".into()));
    Ok(())
  }
}
