# DID Brain

**解離性身份障礙（DID）文獻日報** — 每日自動從 PubMed 抓取最新 DID / 解離症研究文獻，由 Zhipu AI 進行摘要、分類與分析，生成繁體中文日報。

## 架構

- **PubMed E-utilities API** — 抓取最新 DID 相關文獻
- **Zhipu AI (GLM-5-Turbo)** — AI 摘要、PICO 分析、分類
- **GitHub Actions** — 每日台北時間 06:00 自動執行
- **GitHub Pages** — 靜態網頁部署

## 搜尋範圍

涵蓋 12 組 PubMed 搜尋策略，包含：
- 廣泛 DID / 解離症搜尋
- DID + 創傷模式
- DID + 評估診斷
- DID + 心理治療
- DID + 神經影像
- 失自我感 / 失真實感
- DID + 童年創傷
- DID + 共病
- DID + 自傷自殺
- DID + 記憶與認同
- 系統性回顧

## 技術

- Node.js 24（純 ESM 模組）
- 無外部依賴（使用 Node.js 內建 fetch）
- JSON 容錯：四層解析策略
- 模型 Fallback：GLM-5-Turbo → GLM-4.7 → GLM-4.7-Flash
- PMID 歷史去重機制

## 連結

- 🔗 [李政洋身心診所](https://www.leepsyclinic.com/)
- 📧 [訂閱電子報](https://blog.leepsyclinic.com/)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/CYlee)
