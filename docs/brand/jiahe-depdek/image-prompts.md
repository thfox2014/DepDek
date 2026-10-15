# 生成记录

工具：内置 ImageGen。以下为本轮最终视觉稿与独立图标使用的提示词。未使用 CLI/API fallback。

## 品牌视觉稿

参考：已选橙色细门框、绿色圆形及顺时针旋转 45° 的太极式弯道。

原始参考文件：`/Users/mac/.codex/generated_images/019fdad4-77aa-7ff3-bdad-40a10098fbe4/exec-543c5d4d-2078-4f57-b6c0-b756c5ce2287.png`

输出：`brand-board-v1.png`；不透明背景。

```text
Use case: logo-brand. Create an impeccably polished, editorial-quality BRAND IDENTITY PRESENTATION for ONE family AI hub brand, refining the supplied selected logo. Landscape 1536x1024, warm ivory background #F6F3ED, very generous whitespace, sophisticated Swiss/Chinese contemporary graphic design. This is a finished brand identity sheet, not a website or a UI dashboard. Brand name Chinese EXACTLY '家合', English EXACTLY 'DepDek'. Category EXACTLY '家庭 AI 中心'. Brand line EXACTLY '让 AI，走进每个家'. Do not invent any additional text, diagrams, headings or labels.

The reference is the agreed visual concept and MUST remain recognizable: one thin open-bottom, nearly square rounded doorway in ORANGE, surrounding a small JADE circular nucleus divided into two lobes by a broad Taiji-like S-shaped NEGATIVE SPACE channel. The channel is rotated clockwise 45 degrees so it connects upper-right circumference to lower-left circumference (roughly 1:30 to 7:30). Preserve this specific geometry and orientation. Refine the geometry with precise uniform strokes, subtle optical corrections, generous interior space and harmonious proportions: doorway stroke around 10 to 11 percent of its width, core diameter around 32 percent of the outer doorway width, central core sits optically centered within the doorway with relaxed space around it. The whole sign must feel like a welcoming Chinese courtyard threshold containing a calm living intelligence. No literal roof, no maze, no additional dots, no ornament. ONE frame, ONE divided circle. Broaden the channel enough that it reads at small sizes. Crucially eliminate all jagged edges, cyan speckles, glow, gradients, shading, messy transparent fringes or raster artifacts in the reference. Flat solid colors only. Use a restrained mature warm-orange #EA7839 and deep jade #237D6B, paired with ink #252C29.

Composition: on the upper two thirds of the sheet, showcase a large exquisite primary horizontal lockup, with the refined emblem on the LEFT and beautifully kerned custom-feeling Chinese '家合' on the RIGHT, contemporary humanist geometric Chinese lettering, not calligraphy, and English 'DepDek' neatly aligned underneath in a warm precise geometric sans. Below that lockup use the small category line '家庭 AI 中心', with restrained hierarchy. Place the brand line '让 AI，走进每个家' as one quiet line with generous space. Lower portion: one smaller international horizontal lockup using the SAME exact emblem and 'DepDek' in ink on ivory on the lower left; on the lower right show ONE simple charcoal startup-screen application rectangle, flat no device hardware, with the same orange/jade emblem centered, tiny white 'DepDek' beneath it. A thin neutral divider and four tiny carefully aligned palette squares at the very bottom, no labels. Consistency between all emblem instances is critical. ONE identity and supporting usages, not alternative logos. Minimal professional composition with immaculate alignment and expensive-feeling negative space. No stock photos, no 3D mockups, no shadows, no decorative patterns, no unnecessary copy.
```

## 独立透明图标

参考：本轮 `brand-board-v1.png`。

输出：`symbol-v1.png`；请求透明背景。

```text
Use case: logo-brand final asset. Extract and faithfully reproduce ONLY the large refined orange doorway and deep jade divided circle emblem from the upper-left of the attached identity presentation. This is the final standalone logo symbol for the family AI hub '家合 / DepDek'. Use exactly that selected elegant geometric sign: thin orange open-bottom rounded architectural frame with pill-rounded feet, deep jade circular core with a smooth broad S-shaped transparent channel that enters the upper right and exits lower left, a 45-degree-clockwise Taiji division. Preserve its refined proportions and negative spaces. No text whatsoever, no name, no tagline, no palette squares, no line, no board or background, no app tile, no other logos. Clean centered isolated symbol on fully transparent background. Colors must be flat uniform warm orange #EA7839 for the outer frame and deep jade #237D6B for both circular lobes. Perfect smooth crisp solid vector-like edges; no gradients, no shadow, no texture, no cyan fringes, no sketch marks. Square 1024x1024 canvas, symbol around 60 percent of canvas width, generous transparent clear space. Return ONE logo only.
```
