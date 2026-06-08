# 公文系統 Document App

一套輕量的公文製作與簽核流程管理系統。使用 **純 Node.js 標準函式庫**實作（零外部相依套件），前端為原生 HTML/CSS/JavaScript，資料以 JSON 檔案儲存，可直接執行、容易部署。

## 功能

- **公文製作**：支援 函、令、公告、簽、書函、開會通知單等類別，含速別（普通件／速件／最速件）與密等（普通／密／機密／極機密）。
- **自動文號**：依民國年度自動產生流水文號（例：`115-字第0001號`）。
- **簽核流程**：草稿 → 陳核中 → 已核定／已退回 → 已發文 → 已歸檔，每個動作均記錄處理歷程與批示意見。
- **搜尋與篩選**：可依關鍵字（主旨／文號／受文者／承辦人）、狀態、類別過濾。
- **儀表板統計**：即時顯示各狀態公文數量。

## 快速開始

需求：Node.js 16 以上。

```bash
npm start
# 或
node server.js
```

開啟瀏覽器進入 http://localhost:3000

可用環境變數 `PORT` 指定埠號，例如 `PORT=8080 node server.js`。

## 簽核流程

| 動作 | 適用狀態 | 結果狀態 |
| --- | --- | --- |
| 送核 | 草稿 / 已退回 | 陳核中 |
| 核定 | 陳核中 | 已核定 |
| 退回 | 陳核中 | 已退回 |
| 發文 | 已核定 | 已發文 |
| 歸檔 | 已發文 / 已核定 | 已歸檔 |

> 公文僅於「草稿」或「已退回」狀態可編輯內容。

## API 一覽

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/meta` | 取得類別、速別、密等、狀態、動作定義 |
| GET | `/api/stats` | 取得統計數據 |
| GET | `/api/documents` | 列出公文，支援 `?q=&status=&type=` |
| POST | `/api/documents` | 建立公文 |
| GET | `/api/documents/:id` | 取得單一公文 |
| PUT | `/api/documents/:id` | 編輯公文（限草稿／退回） |
| DELETE | `/api/documents/:id` | 刪除公文 |
| POST | `/api/documents/:id/action` | 執行簽核動作 `{ action, actor, note }` |

## 專案結構

```
document-App/
├── server.js          # HTTP 伺服器 + REST API（標準函式庫）
├── package.json
├── data/              # 執行時公文資料（documents.json）
└── public/            # 前端
    ├── index.html
    ├── styles.css
    └── app.js
```

## 資料儲存

公文資料儲存於 `data/documents.json`（已加入 `.gitignore`，不會進版控）。如需備份或遷移，複製此檔即可。
