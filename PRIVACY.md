# Privacy and data flow

L叔工作台 is designed as a single-user, local-first macOS application. The SQLite database and parsed finance summaries stay on the machine unless an optional connector is explicitly enabled.

## Safe defaults

Fresh installs use demo mode, disable schedulers and leave Things, Feishu, desktop scanning and Apple Calendar connectors off. The user enables each connector from Settings after reviewing its permission boundary.

## Local data

The application may store the following under `backend/data`:

- normalized todo and calendar metadata;
- connector checkpoints and sync receipts;
- Xiaohongshu metrics and note summaries;
- hotspot articles and final Moments drafts;
- MoneyCats aggregate summaries;
- AI analysis results and limited evidence summaries.

Do not publish this directory. Delete it to reset the open-source package after stopping the app.

## Optional network recipients

| Recipient | When used | Data sent |
|---|---|---|
| DeepSeek | Only after AI analysis/planning consent | Redacted, length-limited candidate summaries and the local generic/custom work profile; not raw files or the finance database |
| CimiData | Only after credentials are configured and hotspot fetch is triggered | API authentication and the requested source query |
| Open-Meteo | When weather is enabled and the browser grants location | Rounded coordinates needed for weather |
| Nominatim-compatible endpoint | When city-label lookup is enabled | Rounded coordinates and a generic user agent |
| Local knowledge adapter | When configured | Knowledge queries/uploads to the configured local URL |
| OpenCLI / Feishu CLI | When the corresponding local connector is enabled | Commands run through the locally authenticated CLI session |

Things, EventKit and MoneyCats adapters operate locally. MoneyCats data does not require AI.

## Location

Browser geolocation requires a user gesture and browser permission. The project does not ship a default city or coordinate. Weather and reverse-geocoding can be disabled independently.

## Retention and removal

v0.1 has no automated retention policy. Stop the app and remove `backend/data` to delete local runtime records. Back up that directory only if you understand it may contain sensitive metadata.
