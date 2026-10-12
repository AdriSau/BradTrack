# BradTrack

Símbolo original creado para este proyecto: una B geométrica cuyo espacio interior dibuja un recorrido ascendente. Representa seguimiento, continuidad y planificación financiera, sin limitar la marca a carteras, hipotecas o nóminas.

## Archivos

- `bradtrack-mark.png`: símbolo maestro con transparencia, para icono y cabecera.
- `bradtrack-logo.png`: composición horizontal con el nombre, sobre fondo transparente.
- `bradtrack-logo-dark.png`: composición horizontal para fondos oscuros, con el símbolo sobre un soporte marfil.
- `favicon.ico`: icono de pestaña con tamaños 16, 32 y 48 px, sobre soporte marfil para mantener contraste en ambos temas del navegador.
- `bradtrack-favicon-32.png`: alternativa PNG de 32 px para el icono de pestaña.

La cabecera compone el símbolo con el nombre como texto nativo. Mantiene la paleta de marca en ambos temas y adapta el color del nombre al fondo.

## Paleta y uso

- Verde principal: `#176b52`.
- Lima de detalle: `#b5d843`.
- Tinta del nombre: `#17251f`; en oscuro: `#e6e6e6`.
- Fondo marfil: `#f5f6f1`.
- Nombre: Segoe UI, peso 700, espaciado de letras -0.035 em.
- Símbolo en la web: caja de 36 px. Conservar su proporción, el margen transparente y los espacios interiores.
- Evitar sombras, degradados añadidos, distorsión y efectos de contorno.

## Creación

Símbolo generado con la herramienta integrada `image_gen`, habilidad `imagegen`. Las composiciones horizontales se exportan desde HTML/CSS en el navegador, conservando el PNG maestro intacto.

### Prompt utilizado

```text
Use case: logo-brand.
Asset type: Final standalone symbol for BradTrack, a Spanish personal finance application for tracking investment portfolios, mortgages and net salaries.
Primary request: Design a distinctive, original, modern minimalist monogram symbol inspired by a capital B and a financial tracking path. Draw one confident, compact geometric B silhouette: substantial continuous left spine and two rounded right lobes, the lower lobe subtly wider than the upper. A precise ascending stepped channel carved into the negative space connects the two interior counters, suggesting measured progress and tracking without a literal chart or arrow. Integrate one small lime geometric terminal in the upper right end of that interior path, as part of the symbol, not a detached decoration. Prioritize a beautifully balanced memorable silhouette over literal lettering; still clearly reads as a B.
Style/medium: Crisp flat vector-style graphic rendered as a high resolution PNG, two solid colors, restrained softened corners, generous negative space, optical balance, premium contemporary financial software identity.
Color palette: Main shape exactly deep forest green #176b52; very small secondary accent lime #b5d843. Surroundings genuinely transparent. It will sit on warm ivory #f5f6f1 or white; for dark mode it will sit on a pale ivory inset.
Composition: One single symbol centered, square canvas, symbol occupies approximately 84% of both width and height, minimal even transparent padding, no wordmark or other text.
Constraints: Invent a custom geometry, not a stock icon or a recognizable existing brand mark. Must remain clear at 24 to 32 pixels and work in monochrome. No thin strokes, no fine texture, no literal currency sign, no bar chart, no house, no circular arrow, no generic upward arrow, no enclosing tile or badge, no gradient, no shadow, no 3D, no mockup, no white background, no caption, no watermark. Deliver only the isolated logo mark with true alpha transparency.
```
