# 公文系統 Document App

一套輕量的公文製作與簽核流程管理系統。使用 **純 Node.js 標準函式庫**實作（零外部相依套件），前端為原生 HTML/CSS/JavaScript，資料以 JSON 檔案儲存，可直接執行、容易部署。

## 功能

- **公文製作**：支援 函、令、公告、簽、書函、開會通知單等類別，含速別（普通件／速件／最速件）與密等（普通／密／機密／極機密）。
- **收發分流**：區分「發文／收文」，各自獨立流水號。
  - 收文於登記（建立）時即編 **收文號**：`收-115-字第0001號`，並可記錄來文機關／來文字號／來文日期。
  - 發文於執行「發文」動作時才編 **發文號**：`發-115-字第0001號`。
- **會簽多關卡**：每份公文可設定簽核路徑（多個關卡，各有單位／職稱與會簽人），送核後逐關核章，全部通過才核定；任一關退回即回到承辦人並記錄退回意見。未設定路徑時則採單關「核定」。
- **簽核流程**：草稿 → 陳核中（逐關會簽）→ 已核定／已退回 → 已發文 → 已歸檔，每個動作均記錄處理歷程與批示意見。
- **列印套表 / 匯出 PDF**：以標準公文紙格式（含會簽欄、決行欄）開啟列印視窗；於列印對話框選擇「另存為 PDF」即可匯出。
- **登入與權限分級**：帳號登入（Session Cookie），分 系統管理員／文書／主管／承辦人 四種角色，依角色控管建立、簽核、發文、歸檔、附件、稽核等權限。
- **附件上傳**：每份公文可上傳附件（單檔上限 10MB），支援下載與移除；附件實體存於 `data/attachments/`。
- **稽核軌跡**：自動記錄登入、公文建立／修改／刪除、各簽核動作、附件異動等操作（操作者、角色、時間、對象、來源 IP），管理員可檢視並匯出 CSV（含 BOM，Excel 可正確顯示中文）。
- **限辦日期與逾期提醒**：可為公文設定限辦日期，系統自動標示「已逾期」與「即將到期」（預設到期前 3 日內），列表、儀表板均有提醒，並可一鍵篩選。已發文／已歸檔的結案公文不再計入逾期。
- **公文範本**：內建常用範本（一般函稿、開會通知單、簽呈），新增公文時可一鍵套用預填類別／主旨／本文／會簽路徑；管理員可新增、刪除範本，或將現有內容「另存為範本」。
- **Email／系統通知**：簽核流程各環節（送核、會簽、核定、退回、發文、歸檔）自動通知相關人員——站內通知（鈴鐺含未讀數）即時送達，並可寄送 Email。
- **全文檢索**：關鍵字檢索涵蓋主旨、文號、本文、收發文者、會簽路徑、處理歷程與附件名稱；支援多關鍵字（以空白分隔，須全部命中），結果高亮並顯示命中摘要。
- **搜尋與篩選**：可依關鍵字全文檢索，並依收發別、狀態、類別、限辦狀態過濾。
- **儀表板統計**：即時顯示公文總數、收發數量、待辦狀態與逾期／即將到期件數（點擊即套用篩選）。

## 帳號與權限

系統首次啟動會自動建立預設帳號（**請於正式環境盡速修改密碼**）：

| 帳號 | 密碼 | 角色 | 主要權限 |
| --- | --- | --- | --- |
| `admin` | `admin123` | 系統管理員 | 全部權限 + 稽核軌跡 |
| `clerk` | `clerk123` | 文書 | 建立、送核、發文、歸檔、附件 |
| `boss` | `boss123` | 主管 | 核章、核定、退回 |
| `staff` | `staff123` | 承辦人 | 建立、送核、附件 |

> 公文的編輯／刪除／附件移除限**承辦人本人或管理員**。採會簽流程者，主管須逐關「核章」。

### 使用者管理（管理員）

管理員可於「使用者管理」介面：

- 新增帳號（帳號／姓名／角色／密碼）
- 變更角色、啟用／停用帳號
- 重設任一使用者密碼
- 刪除帳號

所有使用者皆可透過「改密碼」自行修改密碼。系統內建防呆：

- 不可停用、降級或刪除**自己**的管理員帳號
- 系統須保留至少一名啟用中的管理員
- 重設密碼、停用、變更角色會即時使該使用者的既有登入失效（須重新登入）

## 快速開始

需求：Node.js 16 以上。

```bash
npm start
# 或
node server.js
```

開啟瀏覽器進入 http://localhost:3000

可用環境變數 `PORT` 指定埠號，例如 `PORT=8080 node server.js`。

## 打包成桌面應用程式

本專案可打包為 Windows／macOS／Linux 的桌面應用程式（以 Electron 包裝，內建啟動伺服器並開啟視窗，重用既有功能）。

### 方式一：產生安裝檔（Electron）

> 打包需安裝相依套件（會下載 Electron），請在有網路的本機執行。建議在目標作業系統上打包（例如要做 Windows `.exe` 就在 Windows 上執行）。

```bash
npm install          # 安裝 electron / electron-builder
npm run electron     # 直接以桌面視窗試跑（開發用）
npm run dist         # 產生目前作業系統的安裝檔，輸出於 dist/
```

指定平台：`npm run dist:win`（Windows `.exe` 安裝檔）、`npm run dist:mac`（macOS `.dmg`）、`npm run dist:linux`（`AppImage` / `.deb`）。

### 用 GitHub Actions 自動打包三平台

專案內含 `.github/workflows/build-desktop.yml`，可在雲端同時為 Windows／macOS／Linux 打包，免在每台機器各跑一次：

- **手動打包**：到 GitHub 專案的 **Actions → Build Desktop App → Run workflow**，完成後於該次執行頁面的 **Artifacts** 下載各平台安裝檔。
- **發版打包**：推送 `v` 開頭的版本標籤，會自動建立 GitHub Release 並附上三平台安裝檔：
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```

> 使用 GitHub 內建的 `GITHUB_TOKEN`，無需額外設定金鑰；macOS 未提供 Apple 簽章憑證時會自動略過簽章。

- 資料儲存於使用者資料夾（不會寫入安裝目錄）：
  - Windows：`%APPDATA%/公文系統/data`
  - macOS：`~/Library/Application Support/公文系統/data`
  - Linux：`~/.config/公文系統/data`
- 應用程式選單「檔案 → 開啟資料夾」可開啟上述資料目錄以備份。
- 圖示（選填）：將 `build/icon.svg` 轉為 512×512 的 `build/icon.png`（Windows 另需 `build/icon.ico`）放入 `build/`；未提供則使用 Electron 預設圖示。

### 方式二：免打包啟動器（需已安裝 Node.js）

不想打包安裝檔時，可直接用啟動器：啟動伺服器並開啟瀏覽器。

- Windows：雙擊 `scripts/start-app.bat`
- macOS／Linux：執行 `scripts/start-app.sh`（或 `bash scripts/start-app.sh`）

### Email 通知設定（選填）

未設定 SMTP 時，通知信會寫入 `data/outbox/`（`.eml` 檔）以供檢視，站內通知仍正常運作。若要實際寄出，設定以下環境變數：

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 \
SMTP_USER=帳號 SMTP_PASS=密碼 SMTP_SECURE=false \
MAIL_FROM="公文系統 <no-reply@example.com>" \
node server.js
```

> 收件者 Email 於「使用者管理」中設定；未填 Email 的使用者僅收站內通知。

## 簽核流程

| 動作 | 適用狀態 | 結果狀態 | 備註 |
| --- | --- | --- | --- |
| 送核 | 草稿 / 已退回 | 陳核中 | 有會簽路徑時由第 1 關開始 |
| 核章 | 陳核中 | 陳核中 →（末關）已核定 | **會簽多關卡**逐關使用 |
| 核定 | 陳核中 | 已核定 | 未設定會簽路徑時使用 |
| 退回 | 陳核中 | 已退回 | 於目前關卡記錄退回意見 |
| 發文 | 已核定 | 已發文 | 限發文公文，於此時編列發文號 |
| 歸檔 | 已發文 / 已核定 | 已歸檔 | 收文核定後可直接歸檔 |

> - 公文僅於「草稿」或「已退回」狀態可編輯內容（含會簽路徑）。
> - 採會簽流程的公文不可直接「核定」，須逐關「核章」；末關核章後自動核定。

## API 一覽

> 除登入相關端點外，所有 API 均需登入（Session Cookie）。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| POST | `/api/login` | 登入 `{ username, password }`，回傳使用者並設定 Cookie |
| POST | `/api/logout` | 登出 |
| GET | `/api/me` | 取得目前登入者（含權限 `caps`），未登入回 401 |
| GET | `/api/meta` | 取得類別、速別、密等、狀態、動作、角色定義 |
| GET | `/api/stats` | 取得統計數據 |
| GET | `/api/documents` | 列出公文，支援 `?q=&status=&type=&direction=&due=`（`due=overdue\|soon`） |
| POST | `/api/documents` | 建立公文（需 `create` 權限） |
| GET | `/api/documents/:id` | 取得單一公文 |
| PUT | `/api/documents/:id` | 編輯公文（限草稿／退回，限承辦人或管理員） |
| DELETE | `/api/documents/:id` | 刪除公文（限承辦人或管理員） |
| POST | `/api/documents/:id/action` | 執行簽核動作 `{ action, actor, note }`（依角色檢核） |
| POST | `/api/documents/:id/attachments` | 上傳附件 `{ filename, data(dataURL) }` |
| GET | `/api/documents/:id/attachments/:attId` | 下載附件 |
| DELETE | `/api/documents/:id/attachments/:attId` | 移除附件（限承辦人或管理員） |
| GET | `/api/audit` | 稽核軌跡列表（限管理員），支援 `?limit=` |
| GET | `/api/audit/export` | 匯出稽核軌跡 CSV（限管理員） |
| POST | `/api/me/password` | 修改自己的密碼 `{ currentPassword, newPassword }` |
| GET | `/api/users` | 使用者列表（限管理員） |
| POST | `/api/users` | 新增使用者（限管理員） |
| PUT | `/api/users/:id` | 更新角色／啟用狀態／姓名（限管理員） |
| DELETE | `/api/users/:id` | 刪除使用者（限管理員） |
| POST | `/api/users/:id/password` | 重設指定使用者密碼（限管理員） |
| GET | `/api/templates` | 公文範本列表 |
| POST | `/api/templates` | 新增範本（限管理員） |
| PUT | `/api/templates/:id` | 修改範本（限管理員） |
| DELETE | `/api/templates/:id` | 刪除範本（限管理員） |
| GET | `/api/notifications` | 取得自己的通知與未讀數 |
| POST | `/api/notifications/read` | 標示已讀 `{ ids }`（省略則全部） |

## 專案結構

```
document-App/
├── server.js          # HTTP 伺服器 + REST API 路由（export start()）
├── electron/
│   └── main.js        # Electron 主程序（桌面視窗 + 內建伺服器）
├── scripts/
│   ├── start-app.sh   # 免打包啟動器（macOS / Linux）
│   └── start-app.bat  # 免打包啟動器（Windows）
├── build/
│   └── icon.svg       # 應用程式圖示來源
├── lib/
│   ├── db.js            # JSON 檔案儲存層
│   ├── auth.js          # 使用者、角色權限、Session
│   ├── audit.js         # 稽核軌跡與 CSV 匯出
│   ├── attachments.js   # 附件存取
│   ├── templates.js     # 公文範本
│   ├── notifications.js # 站內通知
│   └── mailer.js        # Email 寄送（SMTP / outbox）
├── package.json
├── data/              # 執行時資料（不進版控）
│   ├── documents.json
│   ├── users.json     # 含密碼雜湊
│   ├── templates.json
│   ├── notifications.json
│   ├── audit.json
│   ├── attachments/   # 附件檔案
│   └── outbox/        # 未設 SMTP 時的通知信
└── public/            # 前端
    ├── index.html
    ├── styles.css
    └── app.js
```

## 資料儲存與安全性

- 所有執行時資料存於 `data/`，已整個加入 `.gitignore`（含使用者密碼雜湊、稽核軌跡、附件），不會進版控。備份／遷移時複製整個 `data/` 目錄即可。
- 密碼以 scrypt 加鹽雜湊儲存，不存明文。
- Session 以伺服器記憶體維護（重啟即失效），透過 HttpOnly Cookie 識別，預設有效 12 小時。
- 此為輕量示範系統；若部署於正式環境，建議置於 HTTPS 反向代理之後，並修改預設帳號密碼。
