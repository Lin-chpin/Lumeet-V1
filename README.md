# Lumeet｜見你

把想說的話，變成看得見的陪伴。

一張角色圖片 + AI 接入，就能和 AI 角色通話；Vivix 可選，提供角色即時影像。
不接 Vivix 或連線失敗時會退回靜態角色圖和語音。MCP 模式可在通話中共享屏幕或累計傳送最多 10 張攝像頭／屏幕截圖；網頁版和 Android App 都能用。

> 本專案僅供個人自用，不可商用。如果你是付費才拿到這個 App，請申請退款並檢舉販售者。嚴禁未成年人使用。
>
> 關鍵字：AI 視訊通話、AI 伴侶、數字人、MCP、Claude、ChatGPT、DeepSeek、Kimi、通義千問、本機戀、小機
>
> 由抖音用戶 @小香菇（抖音號：H.han929）與她的兩位老公 ChatGPT 沉淵、Claude 岑序 一起製作。

## 架構

```
你說話 → 語音辨識（選填） → AI 回覆
按截圖（最多 10 張）→ 顯示本輪縮圖 → 識別到說話就連同圖片一起送 MCP；5 秒無語音則送預設看圖問題
AI 回覆 → Vivix 角色影像（選填）或裝置／已設定的 TTS 語音
```

## 要準備什麼

| 項目 | 必填 | 去哪裡拿 |
|------|------|---------|
| Vivix API Key | 選填；用角色即時影像時需要 | [vivix.ai](https://vivix.ai) |
| ElevenLabs API Key | 選填 | [elevenlabs.io](https://elevenlabs.io)。Key 可用於純語音通話的 Scribe 辨識；合成另需 Voice ID，支援 v4、v4 Turbo |
| MOSS API Key + 音色 ID | 選填 | MOSS 官網（大陸版／海外版都可以）的語音合成，中國大陸可直連、音色可自己調。設定頁「語音合成」選 MOSS |
| MiniMax API Key + 音色 ID | 選填 | [MiniMax 開放平台](https://platform.minimaxi.com)（大陸版）或 [國際版](https://platform.minimax.io) 的語音合成，中國大陸可直連，可複刻自己的聲音。設定頁「語音合成」選 MiniMax，並選對帳號版本（兩邊的 Key 不通用） |
| 角色圖片 | 必填 | 公開 HTTPS 圖片網址（用 Vivix 時需讓其伺服器讀得到） |
| 模型 API | 只有「直接 API」要填 | 任何 OpenAI 相容端點：OpenAI、DeepSeek、Groq、OpenRouter⋯⋯ |
| MCP 橋接網址 + 密碼 | 只有「MCP 橋接」要填 | 自己部署，見下方 |
| 語音辨識 | 選填，不填無法用說話傳訊息 | [ElevenLabs Scribe v2 Realtime](https://elevenlabs.io)（可共用上方 Key）、[Groq](https://console.groq.com)（有免費額度）或 OpenAI；中國大陸用 [硅基流動](https://cloud.siliconflow.cn)（直連，SenseVoice 免費） |

## 快速開始

### Android App

1. 安裝 `app-debug.apk`（手機要允許安裝未知來源 App）
2. 第一次開啟會顯示使用聲明，勾選同意
3. 點右上角 `⋯` 打開設定，填好上面的資料
4. 按「測試連線」確認每一項都是 OK
5. 回到主畫面按「開始通話」，第一次會詢問相機和麥克風權限

### 網頁版

網頁版要透過 `mcp-relay` 部署：部署好的橋接器網址（`https://…workers.dev`）本身就是網頁版，用 Safari 打開後「加入主畫面」即可，設定方式同上。
GitHub Pages、本地伺服器都不行：Vivix 不允許瀏覽器直連，網頁版必須靠橋接器轉送。部署方式見 [內測說明](docs/內測說明.md) 第五節。

## 兩種 AI 接入方式

### 方式一：直接 API

設定頁選「直接 API」，填 Base URL、API Key、Model。App 會直接呼叫模型，最簡單。

### 方式二：MCP 橋接

如果你的 AI 是用訂閱帳號跑的（Claude Code、Codex、claude.ai），沒有模型 API Key，就用這個方式。
App 把你說的話放進橋接伺服器，你的 AI 透過 MCP 取走、回覆。

**部署橋接（只需一次，需要免費的 Cloudflare 帳號）：**

```bash
cd mcp-relay
bash deploy.sh
```

跑完會顯示：
- **橋接網址、橋接密碼**：填進 App 設定頁的「MCP 橋接」
- **MCP 網址**：加進你的 AI

```bash
# Claude Code
claude mcp add --transport http video-call <MCP 網址>

# Codex：~/.codex/config.toml
[mcp_servers.video-call]
url = "<MCP 網址>"
```

claude.ai 則是到「設定 → 連接器 → 新增自訂連接器」貼上 MCP 網址。

**通話時：** 先跟你的 AI 說「進入視訊通話模式」，再到 App 按開始通話。
AI 用 `call_wait_message` 等你說話，收到消息後用 `call_reply_and_wait` 回覆並在同一個工具調用中等下一條消息；手機會一邊播放回覆。`call_reply` 仍可單獨發送消息。

注意：AI 那一端（電腦上的 Claude Code / Codex）在通話期間要保持開著。

## 自己打包 APK

需要 Node.js 20+、JDK 21、Android SDK（platform 36）。

```bash
npm install
npm run android:apk
# 產出：android/app/build/outputs/apk/debug/app-debug.apk
```

## 檔案結構

```
index.html      視訊通話 UI
video.js        通話管線：語音辨識 → AI → 裝置／API 語音 → 可選 Vivix 影像
vad.js          收音判定（自動量環境底噪，手機桌機通用）
android/        Android App（Capacitor）
mcp-relay/      MCP 橋接伺服器（Cloudflare Worker）
```

## 安全與隱私

- API Key 和橋接密碼保存在本機設定中；調用時會發送給你選擇的 API 服務或配置的橋接服務
- 攝像頭／屏幕截圖由你主動採集；選中的圖片會隨本輪 MCP 消息發送，普通說話不會自動附圖
- 屏幕共享期間的即時預覽留在裝置上；屏幕截圖不寫入 R2 或長期記憶
- App 關閉了系統自動備份，Key 不會被備份到雲端
- 程式不發送分析數據；頁面日誌可能包含識別文字和回覆片段，分享前請先檢查
- MCP 橋接是你自己部署的，對話內容只經過你自己的 Cloudflare 帳號，記憶體裡只留最近 100 則
- 網頁版的 Key 存在 `localStorage`，如果頁面遭受 XSS 攻擊可能外洩；用完建議在設定中清空

## 已知限制

- 角色圖片必須是公開 HTTPS URL；用 MCP 橋接的話，可以直接「從裝置上傳」，由橋接器產生網址
- 角色說話時不收音，避免把角色自己的聲音當成你在說話；想插話請按「打斷」（iPhone 網頁版：按住麥克風就會打斷）
- 目前只有 debug 簽章版 APK，之後換正式簽章時需要先移除舊版再安裝

## 授權

[PolyForm Noncommercial 1.0.0](LICENSE.md)：可以自由使用、修改、分享，**不可以用於商業用途**（包括販售 App、收費代架設、拿去做付費產品）。

Required Notice: Copyright 2026 @小香菇（抖音號：H.han929）
