# Archivos que conviene no tocar sin revisar

Estos archivos pueden romper la app si se cambian mal:

```txt
app.js
supabase-config.js
manifest.json
service-worker.js
```

## Que hace cada uno

```txt
app.js
```

Tiene toda la logica de la app: login, voz, IA, cotizaciones, PDF, historial, clientes y cotizacion inteligente.

```txt
supabase-config.js
```

Tiene la conexion a Supabase. No publiques llaves privadas aqui.

```txt
manifest.json
```

Controla el nombre e icono cuando instalas la app en el celular.

```txt
service-worker.js
```

Controla el cache. Si no se actualiza, el celular puede mostrar una version vieja.

## Regla de oro

No borrar funciones existentes.
No reemplazar toda la app.
Agregar cambios como modulos o secciones nuevas cuando sea posible.

