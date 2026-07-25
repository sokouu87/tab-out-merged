# Superseded: Do not use chrome.processes for tab memory indicators

Status: Superseded on 2026-06-29.

Tab Out will not use `chrome.processes` for tab memory indicators. The API is not available in stable Chrome, which makes per-tab memory indicators unreliable for the extension's default install path.

Tab Out keeps the `chrome.system.memory` snapshot because it reports device-wide physical memory and is independent of per-tab memory estimates. Tab-level status indicators should use stable `chrome.tabs` fields such as `active`, `discarded`, and `frozen`.
