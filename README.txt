医师法每日50题网页 · PWA v2

包含：
- index.html：主页面
- manifest.webmanifest：PWA 清单
- sw.js：离线缓存
- icons/：iPhone 主屏幕图标

重要：
PWA 的“添加到主屏幕”和离线缓存需要网页通过 http:// 或 https:// 访问。
直接在 iPhone“文件”App里点开 index.html 属于 file:// 本地文件方式，Safari 不会把它当成正常可安装的网站。

推荐使用：
1. 把整个文件夹部署到 GitHub Pages / Vercel / Netlify 任意一种静态网站托管服务。
2. iPhone 用 Safari 打开生成的网址。
3. Safari 底部“分享”→“添加到主屏幕”。
4. 以后从主屏幕图标进入即可；首次正常联网加载后支持离线使用。

Mac 本地测试：
在本文件夹打开终端，运行：
python3 -m http.server 8000
然后 Safari 打开 http://localhost:8000

数据：
学习记录保存在浏览器 localStorage 中。v2 沿用 v1 的 doctorLawExam_v1 存储键，因此同一网址/同一浏览器下升级不会主动清除原学习数据。
