# v5 近方形门洞生成记录

工具：内置 ImageGen。基于 v4 的门洞比例调整预览继续修正，保留最终稿。

输出：`brand-lockup-v5-square.png`，不透明背景。

以下是最终修正使用的提示词；像素与比例为生成指导，精确几何留待矢量化统一。

```text
Exact geometric correction of the attached Jiaho logo poster. The orange doorway in this version is STILL TOO NARROW. The user explicitly requests a square lower frame. This edit MUST make the doorway VISIBLY WIDER, not merely reproduce the attached sign.

Expand the ORANGE FRAME horizontally by 18 to 20 percent ONLY, without expanding the green circle or text: move the LEFT orange pillar about 30 pixels LEFT and the RIGHT orange pillar about 30 pixels RIGHT on this 1024 pixel wide canvas. Extend the orange top shoulder between them naturally. The new outer frame width should be about 465 pixels and the doorway body height about 385 pixels, with the left h ascender additional above it. With the existing 55-pixel orange stroke, this yields a nearly SQUARE INNER OPENING of approximately 355 pixels wide by 330 pixels high, appearing stable and comfortably square instead of narrow. Keep the overall h centered at x512, short left ascender and round cap, same top shoulder elevation, same bottom baseline and same stroke thickness. The full h sign, including its short ascender, should now have a nearly square overall bounding shape too. Preserve the open bottom, do NOT add a bottom crossbar. Maintain the lowercase h impression and generous space around the round inner core.

The green circle MUST stay at exactly its current size (about 205 pixels in diameter), position and shape: do not enlarge it, do not stretch it. Keep its diagonal Taiji S-shaped cream gap exactly as reference, from upper right to lower left. Only widen the orange frame. Everything else stays exactly unchanged: vivid orange and jade colors, forest-green lowercase 'jiaho', Chinese '家合', category '家庭 AI 中心', slogan '让 AI，走进每个家', palette dots, cream backdrop with pale apricot and mint corners, and all text sizes and placements. One complete portrait poster, 1024x1536. Minimal impeccable flat graphic design. No extra text, no measurement lines, no textures, no gradients, no shadows.
```
