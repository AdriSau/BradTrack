# Validación de seguridad y privacidad en Git

Fecha: 4 de octubre de 2026.

Revisión previa al commit: 6 de octubre de 2026.

## Revisión de arquitectura previa al commit

Resultado: no se identificaron bloqueos de seguridad pendientes para versionar los cambios actuales, bajo el modelo de aplicación local personal. Se revisaron los 13 archivos candidatos a commit, las fronteras entre navegador, API, disco y Git, los cambios de interfaz y la configuración de CI. No había cambios preparados en el índice.

Se detectó y corrigió una evasión del filtro de la API que las pruebas anteriores no cubrían: `StartsWith('/api/')` distinguía mayúsculas y minúsculas, mientras que los endpoints comparados con `-eq` no las distinguían. Antes de corregirlo, un POST con origen ajeno y tipo `text/plain` a `/API/portfolios` creó una cartera ficticia con HTTP 201. Las comparaciones de PowerShell están documentadas por [Microsoft](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_comparison_operators?view=powershell-5.1).

El filtro usa ahora `StringComparison.OrdinalIgnoreCase`, por lo que aplica los controles antes de atender cualquiera de esas variantes. La nueva regresión comprueba `/API`, `/Api` y `/aPi`, incluyendo sesión, lecturas y escrituras, y verifica que el índice de carteras permanezca intacto. También se confirmó que los arrays JSON en la raíz se rechazan sin guardar datos.

Validación actual: **22 pruebas superadas**, sintaxis PowerShell válida, `git diff --check` sin errores, análisis del índice/copia de trabajo/historial sin coincidencias de secretos y ejecución correcta del hook pre-commit. Los archivos financieros, CSV, credenciales y entornos locales permanecen excluidos. No se ejecutó el workflow en GitHub ni se probó automáticamente la interfaz en un navegador.

El límite de confianza es el equipo local: la API no incorpora autenticación de usuarios del sistema operativo ni cifrado de los archivos financieros. El origen y el token protegen frente a peticiones de otras páginas, pero un proceso local puede obtener un token y construir peticiones. La arquitectura revisada corresponde al uso personal en un equipo de confianza; exponerla a otros equipos o usuarios requiere diseñar autenticación y autorización adicionales.

El visto bueno corresponde a esta copia de trabajo. El hook volverá a analizar el contenido real del índice cuando se haga el commit. Esta revisión no creó un commit ni publicó los cambios.

## Resultado

No se encontraron credenciales, claves privadas ni archivos de carteras o CSV en los archivos versionados, en el índice de Git o en el historial analizado. Las ramas de GitHub coincidían con los commits auditados al realizar la consulta inicial. Los fallos detectados se han corregido en la copia de trabajo local.

Las correcciones están pendientes de commit y de publicación en GitHub. No se modificaron los datos personales ni los cambios previos de la interfaz ajenos a estas correcciones.

## Correcciones aplicadas

- Todas las escrituras de la API requieren el origen local exacto, un token aleatorio de 32 bytes generado al arrancar y `application/json` con UTF-8. Se rechaza Fetch Metadata que indique un origen distinto. El token se obtiene en `/api/session`, se guarda solo en memoria en el navegador y se renueva si se reinicia el servidor. Las lecturas de la API también rechazan orígenes ajenos declarados.
- Los cuerpos se leen por bloques con un máximo real de 4 KiB para crear carteras y 15 MiB para datos e importaciones. El CSV archivado tiene además un límite de 10 MiB de UTF-8. Los límites funcionan sin `Content-Length`. Cada lectura tiene un plazo total de 10 segundos y se han configurado límites de espera HTTP. Las desconexiones durante el envío de una respuesta no detienen el servidor.
- La validación comprueba objetos, arrays, propiedades admitidas, fechas reales, símbolos, operaciones BUY/SELL, números finitos no negativos, cantidades positivas y límites de elementos. Un documento inválido se rechaza antes de sustituir el archivo anterior. Los archivos heredados válidos sin `settings` siguen siendo compatibles.
- Las respuestas incorporan `Cache-Control: no-store` y `Cross-Origin-Resource-Policy: same-origin`, conservando CSP y `nosniff`.
- `.gitignore` protege entornos virtuales, archivos de credenciales, claves privadas, exportaciones financieras y copias de bases de datos. `.env.example` se permite para documentar valores ficticios.
- `tools/check_secrets.py` analiza el índice completo, la copia de trabajo y, con `--all`, el historial alcanzable. Rechaza rutas privadas aunque se hayan añadido con `git add -f` y patrones de secretos sin mostrar sus valores. El hook de `.githooks/pre-commit` se ha activado en este clon mediante `core.hooksPath`. Los nuevos clones deben activarlo con `git config --local core.hooksPath .githooks`.
- `.github/workflows/security.yml` ejecuta el análisis de Git y las pruebas en pushes y pull requests. Usa permisos de lectura y checkout fijado al commit de [v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1), sin guardar credenciales de Git. Se activará cuando se publique el workflow; no se ejecutó remotamente durante esta corrección.

Comprobaciones reproducibles:

```powershell
python -m unittest discover -s tests -v
python tools/check_secrets.py --all
git hook run pre-commit
```

Las pruebas usan carpetas ignoradas nuevas y datos sintéticos. Cubren escrituras válidas, protección de origen y token en todos los endpoints, conservación de datos tras errores, límites de bytes y tiempo, cabeceras de seguridad, rutas privadas y secretos sintéticos en el índice e historial. Python se necesita para las comprobaciones y el hook; la aplicación sigue ejecutándose con PowerShell sin dependencias adicionales.

Resultado local: 13 pruebas de API/exclusiones y 7 del control de Git superadas, sintaxis PowerShell válida y análisis de secretos sin coincidencias. Se verificaron los hashes de los seis archivos personales de `.data` presentes al comenzar: permanecen iguales. Las carpetas y servidores de prueba se eliminaron. El hook se ejecutó correctamente. La interfaz se revisó por código y peticiones HTTP equivalentes; no se realizó una prueba automatizada en navegador.

Para usar el servidor corregido, detener la instancia anterior y abrir de nuevo `Abrir-BradTrack.bat`. El lanzador reutiliza una instancia ya abierta, por lo que cambiar el archivo no actualiza un proceso existente.

## Alcance y evidencia

- Se revisaron los seis archivos versionados y las modificaciones locales existentes de `app.js`, `index.html` y `styles.css`. No había cambios preparados en el índice ni archivos sin seguimiento y sin exclusión al iniciar la revisión.
- Se analizaron los dos commits accesibles desde las referencias locales y los 13 objetos de tipo blob existentes en ese momento, incluidos los no alcanzables desde ramas. Las rutas históricas contienen exclusivamente los mismos seis archivos del proyecto.
- Se buscaron patrones de claves privadas, tokens de proveedores, JWT, asignaciones de credenciales, URLs con contraseñas, literales de alta entropía y algunos identificadores personales. No hubo coincidencias. También se comprobó la configuración local del remoto sin incluir valores sensibles en el informe.
- Se compararon los contenidos completos de siete archivos locales JSON/CSV de datos con los blobs de Git: ninguna coincidencia. Esta comprobación no descarta por sí sola fragmentos parciales o datos transformados.
- La consulta de solo lectura al remoto confirmó `main` y `HEAD` en `2b2f367db921598a56fed2422c9ce91140a4ff53`, y `dev` en `c75a966b5d3a3b79464a140c62a4e18ef8d3dd5a`. Ambos commits fueron revisados.
- Las pruebas HTTP utilizaron una instancia separada, datos ficticios y otro puerto. No se utilizó el servidor habitual ni se alteraron las carteras personales.

## Privacidad en Git

En la revisión inicial, `.gitignore:1-4` excluía `.data/`, archivos `*.tmp`, `CONTEXT.md` y `resources/`. `git check-ignore -v` confirmó las exclusiones para los archivos de carteras y el CSV de referencia. `.venv/` dependía de su propio `.gitignore`; ahora también tiene una regla en la raíz.

**Carencia preventiva original, corregida:** `.env`, `.env.local`, archivos de credenciales, claves privadas y CSV colocados fuera de las carpetas excluidas no tenían reglas preventivas. No se encontraron archivos expuestos en la revisión inicial.

Recomendación: añadir reglas explícitas para `.env` y `.env.*`, directorios de credenciales, claves privadas, entornos virtuales y exportaciones financieras. Si se necesita un `.env.example`, debe contener exclusivamente valores ficticios. Incorporar además una comprobación de secretos antes de cada commit y en CI.

Las exclusiones de Git no eliminan archivos ya versionados y pueden saltarse con `git add -f`; deben complementarse con el análisis del índice y del historial. Referencias: [gitignore](https://git-scm.com/docs/gitignore), [git add](https://git-scm.com/docs/git-add).

## Hallazgos originales de la aplicación, corregidos

Las líneas y el comportamiento descritos a continuación corresponden a la versión anterior a las correcciones. Se conservan como evidencia de la revisión inicial.

### 1. Escrituras sin comprobación de origen — prioridad alta

Ubicación: `Start-BradTrack.ps1:77` y `Start-BradTrack.ps1:120`; afecta también al endpoint de importaciones.

El servidor procesa POST sin verificar `Origin`, `Sec-Fetch-Site`, un token de protección o el tipo de contenido. Una solicitud con origen ajeno y `Content-Type: text/plain` creó una cartera con HTTP 201 y sobrescribió los datos de la cartera ficticia `default` con HTTP 200.

Esto permite modificaciones no autorizadas si una petición de otra página consigue alcanzar el servidor local. La ausencia de CORS no protege frente a escrituras mediante solicitudes simples. La prueba confirmó el comportamiento del servidor mediante un cliente HTTP; no fue una prueba de explotación en un navegador. Las restricciones de acceso a la red local de cada navegador pueden limitar la posibilidad de explotación.

Recomendación: exigir el origen exacto esperado para las escrituras del navegador, comprobar Fetch Metadata, rechazar tipos distintos de `application/json` y añadir protección CSRF. Si se pretende restringir también el acceso desde otros procesos locales, hace falta un mecanismo de autenticación adicional. Escuchar en loopback no autentica al cliente. Referencia: [prevención de CSRF de OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### 2. Límite de importación eludible y lectura sin límite — prioridad media

Ubicación: `Start-BradTrack.ps1:137` y `Start-BradTrack.ps1:142`; las lecturas de cuerpos en las líneas 79 y 122 tampoco tienen límite propio.

La importación comprueba únicamente `ContentLength64`. Una petición con transferencia por bloques, sin una longitud declarada, almacenó un CSV ficticio de 15.728.641 bytes, superior al límite de 15.728.640 bytes. El cuerpo completo de la solicitud tenía 15.728.708 bytes y recibió HTTP 200.

Además, los endpoints de creación y actualización leen todo el cuerpo con `ReadToEnd()`. El servidor procesa las solicitudes secuencialmente, lo que amplifica el impacto de clientes lentos o cuerpos grandes sobre la disponibilidad.

Recomendación: limitar los bytes efectivamente leídos en todos los endpoints, también con transferencia por bloques; establecer tiempos máximos y límites al contenido almacenado. El límite del frontend no protege el servidor frente a clientes directos.

### 3. Datos inválidos aceptados y persistidos — prioridad media

Ubicación: `Start-BradTrack.ps1:124-130`.

La validación comprueba únicamente que existan las propiedades `transactions`, `quotes` y `history`. Se envió un objeto ficticio donde eran, respectivamente, una cadena, null y un número: recibió HTTP 200 y se escribió en la cartera de prueba. La interfaz espera estructuras concretas y puede fallar al cargar esos datos.

Recomendación: validar tipos, fechas reales, operaciones admitidas, símbolos, cantidades, precios, comisiones y tamaños antes de escribir. Rechazar el documento completo si no cumple el esquema, conservando el archivo anterior.

### 4. Respuestas financieras sin política explícita de caché — prioridad baja

Ubicación: `Start-BradTrack.ps1:54-62`.

La respuesta de la API no incluye `Cache-Control`. Recomendación: usar `Cache-Control: no-store` en las respuestas con datos financieros para evitar su conservación por cachés HTTP. Esto no sustituye los controles de acceso al equipo ni protege los archivos en disco.

## Controles favorables

- El servidor escucha en `127.0.0.1`, sin exponer la aplicación directamente a la red local.
- Las rutas estáticas usan una lista cerrada. Las solicitudes directas a `/.data/portfolios.json`, `/.git/config` y `/resources/_test.csv` devolvieron HTTP 404.
- Las respuestas incluyen una CSP restrictiva, protección frente a incrustación en marcos y `X-Content-Type-Options: nosniff`.
- Los símbolos y alias insertados en HTML se escapan; otras salidas de texto usan `textContent` o elementos `Option`. No se detectó una vía evidente de XSS en la revisión.
- Los identificadores de cartera se restringen por expresión regular y los nombres de CSV se normalizan antes de escribir.
- Las llamadas `fetch` de la aplicación son relativas a la API local. No se encontraron cargas de recursos remotos, analítica ni envío de las carteras a servicios externos.
- No hay manifiestos de dependencias de terceros en el proyecto versionado.

## Límites de la validación

El análisis de secretos usó patrones propios y una heurística de entropía, no un catálogo exhaustivo de un escáner especializado. Un resultado sin coincidencias no certifica ausencia absoluta de información sensible.

La comprobación remota cubre las referencias anunciadas actualmente por `origin`, no copias, forks, caches o contenido eliminado que GitHub pudiera conservar. La revisión no evaluó permisos de la cuenta de GitHub, protección de ramas, el sistema operativo ni otros procesos del equipo.

Una solicitud adicional con segmentos `..` en la URL no completó la prueba dentro del tiempo previsto; no se atribuye un resultado de protección o vulnerabilidad a ese caso. Las pruebas confirmadas de rutas privadas son las tres indicadas anteriormente.

Los fallos identificados en esta revisión están corregidos localmente. Los controles de secretos son preventivos y pueden saltarse deliberadamente; la protección de ramas y las políticas de GitHub quedan fuera de esta intervención.
