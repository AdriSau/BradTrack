# BradTrack

Símbolo abstracto creado para el proyecto: dos bandas encajadas forman un recorrido continuo con una apertura diagonal. Sugiere seguimiento y planificación, con una silueta compacta que sirve tanto para inversiones como para hipotecas y nóminas.

## Archivos

- `bradtrack-mark.png`: símbolo maestro con transparencia.
- `bradtrack-logo.png`: composición horizontal para fondos claros.
- `bradtrack-logo-dark.png`: composición horizontal con símbolo azul y nombre claro para fondos oscuros.
- `favicon.ico`: icono de pestaña en 16, 32 y 48 px, sobre soporte marfil para conservar el contraste.
- `bradtrack-favicon-32.png`: alternativa PNG de 32 px.
- `previous-logo/`: archivos conservados de la propuesta anterior.

La cabecera compone el símbolo con texto nativo. En oscuro, utiliza la transparencia del maestro como máscara para colorearlo con el azul de la interfaz, sin añadir un recuadro. Las imágenes se sirven por rutas explícitas del servidor local. La versión `?v=3` renueva los recursos de marca en el navegador.

## Paleta y uso

- Verde principal: `#176b52`; detalle lima: `#b5d843`.
- Símbolo en oscuro: `#6eaed6`.
- Nombre: `#17251f` en claro y `#e6e6e6` en oscuro.
- Soporte del favicon: `#f5f6f1`.
- Nombre en la cabecera: Segoe UI, 17 px, peso 650, espaciado de letras -0.025 em.
- Símbolo en la cabecera: 28 px, separado del nombre por 8 px.
- Conservar proporciones y espacios interiores. Evitar sombras, contornos y efectos añadidos.

## Creación

Símbolo generado con la herramienta integrada `image_gen` y la habilidad `imagegen`. Las composiciones y los iconos se exportan desde HTML/CSS en el navegador, conservando el PNG maestro intacto.

### Prompt utilizado

```text
Use case: logo-brand.
Asset: final abstract standalone logo mark for BradTrack, a restrained Spanish finance application with investment tracking, mortgage planning and net salary calculation.
Design a fresh original compact abstract symbol, NOT a letter B. The idea is a continuous tracking route made from TWO bold interlocking rounded corner bands, diagonally offset. Together they form a balanced compact almost-square silhouette, with one generous clean diagonal negative-space passage through the center. The silhouette should feel like a folded route or two linked steps, conveying continuity, overview and measured movement. The two main bands are the same deep forest green #176b52; a short substantial terminal section on the upper right uses muted chartreuse #b5d843, visually integrated into the route. One simple memorable optical gesture, a custom geometric mark, not a collection of financial pictograms.
Execution: pristine flat vector-style logo graphic, absolutely uniform solid fills, precise geometry and smooth clean edges. No shading, no gradients, no texture, no embossing, no light effects, no 3D. Make the central opening and bands wide enough to stay clear at 16 pixels. Almost equal width and height, thick confident geometry, modest rounded corners rather than pill shapes. Elegant modern product identity, calm and understated, not a playful mascot.
Composition: one symbol centered on a truly transparent square canvas. Tight framing: logo occupies 88 percent of canvas with even small padding. No wordmark, no captions, no presentation board, no tile, no border, no background.
Avoid: capital B, any literal letters, dollar or euro signs, houses, coins, bar graphs, upward arrows, spirals, infinity symbols, familiar stock fintech logos, tiny isolated decorative dots, generic rounded app icon containers, mockups, shadows, watermark. Deliver only the clean original isolated two-band symbol with real alpha transparency.
```
