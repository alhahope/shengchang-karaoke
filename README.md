# 声场 Karaoke

一个本地优先的浏览器 K 歌房。歌曲、麦克风声音和录音都在用户自己的浏览器中处理，不需要把私人歌库上传到服务器。

在线体验：[shengchang-karaoke.re-xgrant9838.chatgpt.site](https://shengchang-karaoke.re-xgrant9838.chatgpt.site/)

## 功能

- 选歌台：批量导入、搜索、收藏、分类筛选、待唱队列和下一首
- KTV 视频：导入 MKV、MPG、MPEG，自动转换为浏览器可播放的 MV
- 原唱/伴奏：识别双音轨或左右声道，并支持一键切换和对调
- 音频伴奏：支持 MP3、WAV、M4A、AAC、OGG、FLAC 等浏览器可读取格式
- 歌词：导入 LRC、粘贴带时间标签的歌词或自动排列普通文本
- K 歌控制：播放、暂停、快进、快退、音量和回声
- 声音设备：选择麦克风和输出设备（取决于浏览器支持）
- 耳返与录音：实时监听麦克风，录制并下载演唱结果
- 隐私：歌曲文件不上传；选歌台只在当前页面会话中保存

## 浏览器建议

- Windows 10/11：最新版 Chrome 或 Edge
- macOS：最新版 Chrome；Safari 可使用大部分功能，但输出设备切换可能受限
- 麦克风功能需要 HTTPS 或 `localhost`，并需要用户主动授权

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开终端中显示的本地地址。生产构建：

```bash
npm run build
npm start
```

运行测试：

```bash
npm test
```

## 使用歌库

1. 点击顶部的“选歌台”。
2. 点击“批量导入歌曲”，一次选择多个本地文件。
3. 使用分类、搜索和收藏找到歌曲，再点击“点歌”。
4. MKV/MPG 首次转换时会下载约 31 MB 的 ffmpeg.wasm 核心。

如果文件名使用 `歌手 - 歌名.mkv` 格式，选歌台会自动拆分歌手和歌名。

## 技术栈

- React 19、Next.js/Vinext、TypeScript
- Web Audio API、MediaDevices、MediaRecorder
- ffmpeg.wasm（浏览器内 MKV/MPG 探测、转码和音轨提取）
- Cloudflare Workers / Sites 部署结构

## 部署

普通本地运行不需要 `.openai/hosting.json`。如果使用 OpenAI Sites 部署，可复制示例配置：

```bash
cp .openai/hosting.example.json .openai/hosting.json
```

然后将 `project_id` 替换为自己的 Sites 项目编号。不要提交个人站点的真实项目编号。

## 数据与版权

本仓库不包含任何歌曲、MV、伴奏或歌词。请只使用你拥有或已获授权的媒体文件。第三方依赖和媒体编解码组件分别受其自身许可证约束。

## 参与贡献

欢迎提交问题和改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

项目源代码采用 [MIT License](LICENSE)。
