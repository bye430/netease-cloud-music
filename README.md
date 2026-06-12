# 网易云音乐Linux桌面版

## 功能

- 独立窗口播放，登录状态持久化
- 系统托盘：显示窗口、播放/暂停、上一首/下一首
- 歌词悬浮窗：同步显示当前播放歌词，可设置字体、颜色与不透明度
- 关闭窗口后最小化到托盘，不退出应用
- 窗口大小与位置记忆、单实例运行

## 环境要求

- Ubuntu / Debian 等 Linux 桌面环境
- Node.js 18+

## 开发运行

```bash
cd neteasemusic
npm install
npm start
```

## 编译 deb 包

```bash
npm run dist:deb
```

产物位于 `dist/`，例如：

```
dist/netease-cloud-music_1.0.0_amd64.deb
```

