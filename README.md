# 小宇宙 Desktop

一个安静、轻巧的非官方 Windows 桌面播客播放器。基于 Electron、Vue 3、TypeScript 和 Pinia。

## 使用

打开 release/Xiaoyuzhou-0.2.0-portable.exe 即可使用，不需要安装 Node.js。

- **RSS 收听**：打开「我的订阅」→「RSS 订阅」，粘贴公开的 RSS 2.0 或 Atom 地址。
- **连接账号**：点击左下角账号入口，获取二维码，用手机小宇宙 App 扫描并确认。
- **浏览与搜索**：登录后浏览官方订阅，按兴趣关键词检索，打开播客查看单集。
- **播放**：底部支持暂停、前后 15 秒、上下集、音量、倍速、定时停止和队列。
- **设置**：选择浅色 / 深色 / 跟随系统，调整默认音量、倍速、自动播放和续听偏好。

「发现」通过分类关键词搜索内容，不冒充官方推荐榜单。付费节目需要已有官方购买权限。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 播放 / 暂停 | Space（焦点不在输入框或按钮时） |
| 前往搜索 | Ctrl + K（焦点不在输入框或按钮时） |
| 上一集 / 下一集 | Ctrl + Alt + ← / → |
| 收起播放队列 | Esc |

## 本地数据

RSS 订阅地址、收听历史、进度和设置保存在应用的本地数据目录。凭据仅在主进程内使用，并由 safeStorage 加密保存。应用不保存可复用的音频临时 URL，不会自动把本机历史同步到云端。手机历史与进度可以拉取到电脑；导入的账号记录和登录期间的官方播放记录按账号隔离，退出后隐藏，重新登录可恢复。RSS 和旧版本的本机历史继续保留。

旧版收听记录可继续读取；官方历史按单集标识获取最新详情与播放地址，不依赖播客第一页是否包含该单集。RSS 源已移除的单集可能无法重新获取。

## 开发

环境要求：Node.js ^22.18.0 或 >=24.12.0，Windows。

```sh
npm ci
npm run electron:dev
```

前端浏览器预览可运行 `npm run dev`，但官方账号和 RSS 网络请求需要 Electron 桥接。

```sh
npm test
npm run type-check
npm run lint
npm run build
npm run electron:dist
npm run electron:installer
```

`electron:dist` 生成 Windows 便携版到 release/。`electron:installer` 生成 Windows x64 安装程序到 release/installer/，提供安装向导、目录选择、快捷方式和卸载入口。不要用旧版 exe 判断新版源码效果。

开源与版本发布说明见 OPEN_SOURCE_RELEASE.md。公开署名为 woshixiaocaia，项目采用 MIT License。GitHub 公开仓库：[woshixiaocaia/xiaoyuzhou-desktop](https://github.com/woshixiaocaia/xiaoyuzhou-desktop)。本分支版本为 v0.2.0；公开发布状态请以 GitHub Releases 为准。

## 目录

- src/components：导航、播放器、队列、内容卡片与单集组件
- src/views：发现、搜索、订阅、历史、账号和设置
- src/stores：播放、会话、官方内容、RSS、历史与偏好状态
- electron：窗口、IPC、网络请求与加密凭据存储
- tests：纯逻辑、数据契约与会话回归测试

## 验收与限制

详见 RELEASE_NOTES.md 和 ACCEPTANCE.md。离线测试与模拟接口验收不能替代真实账号扫码后的线上联调。应用不包含托盘常驻、下载、购买、自动更新功能，也不会绕过官方付费权限。

本项目为非官方客户端，与小宇宙官方无隶属关系。接口变动可能影响账号功能。本地便携版未做代码签名。

## 许可证与署名

Copyright (c) 2026 woshixiaocaia。项目原创代码采用 [MIT License](LICENSE)。第三方依赖保留各自的许可和版权声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

项目许可证不授予对第三方播客内容、服务名称、封面或商标的权利。

## 0.2.0 更新

- 修复对象翻页游标无法通过桌面通信造成的“加载更多”失效。
- 播客使用独立页面显示全部单集，可继续分页加载。
- 搜索默认展示单集，仍可切换到播客或全部内容。
- 收藏读取 `/v1/favorite/list`，与个人主页的“喜欢”区分。
- 收听历史读取手机账号记录及进度，按账号隔离；本次仅从手机读取，电脑进度不会回传。
