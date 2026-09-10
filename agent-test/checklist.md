# checklist.md — t9 最终验收清单

供 t9 核验最终产物，除注明外全部针对 `agent-test/index.html`。共 14 条。

- [ ] 1. index.html 存在且为完整单文件页面（t6 高风险：t2 声称完成但零产出，t7 须从零写完整骨架+CSS） —— 如何核验：agent-test 目录下该文件存在，且包含完整 <html>/<head>/<body>、<style> 与 :root 变量定义
- [ ] 2. <style> 标签 ≤1 且无 <link>、@import、url(http)、外链 <img src=（规格标准 2） —— 如何核验：在 index.html 搜索 `<style`、`<link`、`@import`、`url(http`、`<img`，style 计数 ≤1、其余 0 命中
- [ ] 3. 离线打开无网络请求（标准 1） —— 如何核验：浏览器离线打开 index.html，devtools Network 面板 0 个外部请求
- [ ] 4. 5 个区块 id 依次为 section-hero → section-pyramid → section-deps → section-table → section-footer（标准 3） —— 如何核验：grep -n 'id="section-' index.html，恰好 5 个命中且顺序一致
- [ ] 5. 金字塔区有 <section id="section-pyramid"> 包裹（t6 中风险：t5 片段只有 div.pyramid、无 section） —— 如何核验：index.html 中 .pyramid 容器位于 section id="section-pyramid" 之内
- [ ] 6. 金字塔恰好 5 行、宽度 class 顺序 row-w20 → row-w40 → row-w60 → row-w40 → row-w20（标准 4） —— 如何核验：在 section-pyramid 区统计 .pyramid-row 为 5 个，且宽度 class 出现顺序与 20/40/60/40/20 对应
- [ ] 7. 5 行水平居中、实际宽度为 20/40/60/40/20%（标准 4） —— 如何核验：index.html 的 CSS 中 .pyramid-row 含 margin:0 auto（或等效居中）且 .row-w20/.row-w40/.row-w60 宽度分别为 20/40/60%
- [ ] 8. 无残留内联 style="width:..."（t6 低风险：t5 片段内联宽度与 class 重复、会覆盖 CSS） —— 如何核验：在 index.html 搜索 `style="width`，0 命中，或值与该行 row-w class 完全一致
- [ ] 9. hero 多余统计行已处理（t6 中风险：t4 片段含「3 个 agent / 9 个任务 / 5 层」三个 span，content.md 无此文案） —— 如何核验：index.html 中该行已删除，或三个 span 文字与 content.md 第 1 节逐字一致
- [ ] 10. 任务表恰好 9 行数据（t1~t9，标准 5） —— 如何核验：index.html 的 section-table 区表格数据行（不含表头）计数为 9，且文字与 content.md 第 4 节一致
- [ ] 11. 640px 视口无横向滚动（标准 6） —— 如何核验：浏览器视口宽 640px 打开 index.html，无水平滚动条、document 的 scrollWidth ≤ 640
- [ ] 12. 全页只出现 10 个白名单 class（标准 7） —— 如何核验：提取 index.html 全部 class="..."，拆分后每个 class 均在 {.container, .hero, .pyramid, .pyramid-row, .row-w20, .row-w40, .row-w60, .deps, .table, .footer} 内
- [ ] 13. section-deps / section-table / section-footer 三个区块有实际内容（t6 低风险：此三区待 t7 产出，防止合并时漏块） —— 如何核验：index.html 中三个 section 非空占位：deps 有依赖说明、table 有 9 行表格、footer 有落款文字
- [ ] 14. UTF-8 中文正常显示（标准 8） —— 如何核验：浏览器打开 index.html，标题与正文中文无乱码（文件为 UTF-8 编码且含 <meta charset> 声明）
