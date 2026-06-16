# Guia para editar la app desde GitHub

Esta app ya funciona desde GitHub Pages. La idea es que puedas hacer cambios sin depender de la computadora.

## Link de la app

https://laurasolis130390-png.github.io/taller-solis-cotizador/

## Carpeta importante

La app publicada usa los archivos de esta carpeta:

```txt
web-pwa
```

Cuando subas o edites archivos en GitHub, deben quedar en la raiz del repositorio publicado, junto a:

```txt
index.html
styles.css
app.js
service-worker.js
manifest.json
logo-solis.png
```

## Como editar desde GitHub sin computadora

1. Entra a tu repositorio:

```txt
https://github.com/laurasolis130390-png/taller-solis-cotizador
```

2. Presiona la tecla:

```txt
.
```

3. Se abre un editor en el navegador.

4. Abre el archivo que quieres cambiar.

5. Edita.

6. En el lado izquierdo entra a Source Control.

7. Escribe un resumen del cambio, por ejemplo:

```txt
Actualiza modulo cotizacion inteligente
```

8. Da clic en Commit.

9. Espera que GitHub Actions tenga palomita verde.

10. Abre la app con version nueva:

```txt
https://laurasolis130390-png.github.io/taller-solis-cotizador/?v=230
```

Cada vez que hagas cambios importantes, sube el numero:

```txt
?v=231
?v=232
?v=233
```

## Archivos que normalmente se editan

```txt
index.html       Pantallas y botones
styles.css       Colores, tamanos, diseno
app.js           Logica, IA, calculos, PDF
service-worker.js Cache de la app
manifest.json    Icono y nombre de app instalada
```

## Regla importante

Cuando cambies algo de la app, tambien cambia la version de cache en:

```txt
service-worker.js
```

Ejemplo:

```txt
const CACHE_NAME = "taller-solis-cotizador-v23";
```

Si no cambias eso, el celular puede seguir viendo una version vieja.

## Para pedir cambios sin tocar codigo

Abre este archivo:

```txt
CAMBIOS_PARA_LA_APP.md
```

Escribe lo que quieres cambiar usando el formato.

Luego puedes copiar ese texto y mandarmelo para que yo te diga exactamente que modificar o te prepare los archivos.

