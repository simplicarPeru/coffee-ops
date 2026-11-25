# Operación de tiendas

Seguimiento diario de las tiendas en tres momentos: **Apertura**, **Mediodía** y **Cierre**.
Cada acción queda registrada como evento con hora, y la apertura pasa por aprobación del rol administrativo.

Stack: **Vercel** (la app) + **Supabase** (PostgreSQL para los datos y Storage privado para las fotos).

## Roles

| Rol            | Qué hace                                                                 |
|----------------|--------------------------------------------------------------------------|
| Administrador  | Crea y edita tiendas, usuarios, líderes y baristas. Ve todo.            |
| Administrativo | Ve el panel del día, **aprueba o rechaza** aperturas y exporta reportes. |
| Líder          | Completa el checklist de su tienda, marca entrada y salida, toma fotos. |
| Barista        | Igual que el líder, para su tienda.                                      |

Aprobar es función del **rol** administrativo: cualquier persona con ese rol puede aprobar, y el reporte
guarda quién aprobó y con qué rol.

## Horario y ubicación de cada tienda

- **Hora de apertura** por tienda (por defecto 07:00). Las tiendas en bancos pueden tener otra hora.
- **Ubicación y radio** (por defecto 150 m). Se ponen en el formulario de la tienda, con el botón
  "Usar mi ubicación actual" estando en el local, o pegando las coordenadas.

## Verificación de la entrada

1. Al tocar **Entrar**, el celular envía su ubicación.
2. Si está dentro del radio de la tienda, la entrada queda como **ubicación**.
3. Si no hay ubicación, o está fuera del radio, se pide una **foto de la entrada** con la cámara,
   que queda como **foto** y se muestra en el reporte.

La geolocalización del navegador solo funciona en HTTPS (Vercel lo da) o en localhost.

## Estructura

```
app.js              Rutas y reglas de negocio (Express)
server.js           Arranque local (npm start)
api/[...all].js     Función de Vercel que sirve /api/*
vercel.json         Configuración de Vercel (rutas /login y /tienda)
lib/db.js           Acceso a PostgreSQL
lib/storage.js      Fotos: Supabase Storage (producción) o carpeta uploads (local)
supabase/schema.sql Esquema de la base de datos
scripts/migrate.js  Aplica el esquema (npm run db:migrate)
public/             Pantallas (login, panel, tienda)
config.js           Momentos del día y puntos del checklist
```

## Ejecutar en local

Requiere Node.js 20+ y una base PostgreSQL (puede ser la de Supabase o una local).

```bash
cd coffee-ops
npm install
cp .env.example .env        # y completa los valores
export DATABASE_URL=postgresql://postgres:clave@localhost:5432/coffee DATABASE_SSL=false
npm run db:migrate
ADMIN_PIN=una-clave PORT=3000 npm start
```

Sin variables de Supabase, las fotos se guardan en `uploads/`. Entrar en `http://localhost:3000/login`.

## Publicar: Supabase + Vercel

### 1. Supabase

1. Crear un proyecto nuevo, en la región **South America (São Paulo)** para tener baja latencia desde Perú.
2. **Database → Connection string → Transaction pooler**: copiar la cadena y reemplazar la contraseña.
   Va en `DATABASE_URL`.
3. Aplicar el esquema: en **SQL Editor** pegar el contenido de `supabase/schema.sql` y ejecutarlo.
   (Alternativa: `DATABASE_URL=... npm run db:migrate` desde tu computadora.)
4. **Storage → New bucket**: nombre `fotos`, **Private** (sin acceso público).
5. **Project Settings → API**: copiar la URL del proyecto (`SUPABASE_URL`) y la clave **service_role**
   (`SUPABASE_SERVICE_ROLE_KEY`). Esta clave da acceso total: solo va en Vercel, nunca en el navegador ni en el código.

### 2. Vercel

1. Subir este código a un repositorio **privado** de GitHub.
2. En Vercel: **Add New → Project**, importar el repositorio. Framework: *Other*. No cambiar la configuración de build.
3. **Settings → Environment Variables** (en Production):
   - `DATABASE_URL`, `DATABASE_SSL=true`, `DATABASE_POOL_MAX=3`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET=fotos`
   - `ADMIN_USER=admin`, `ADMIN_PIN=` un PIN nuevo de 4 a 6 números
4. Desplegar. La primera vez el servidor crea las 12 tiendas y el usuario administrador.
5. Entrar a `https://TU-PROYECTO.vercel.app/login` y cambiar el PIN del administrador desde **Usuarios**.

Notas:
- Vercel Hobby es para uso no comercial. Para operar un negocio, usar el plan **Pro**.
- Las funciones de Vercel aceptan solicitudes de hasta unos 4,5 MB. Las fotos se reducen en el celular antes de subir.
- Las URLs de las fotos son firmadas y expiran en 1 hora; el panel las renueva al recargar.

## Datos

- Base: tablas `users`, `stores`, `sessions`, `checks`, `approvals` y `events`. Todo se guarda con hora.
- Fotos: bucket privado `fotos`, con rutas `AAAA-MM-DD/tienda/archivo`.
- Respaldo: Supabase hace copias según tu plan. Además conviene exportar `events` y `approvals` cada mes.

## Pendientes antes de usarlo con datos reales

1. **Límite de intentos al entrar.** El PIN hoy no tiene bloqueo tras varios intentos fallidos.
2. **Pausa de Supabase gratis:** el plan gratuito se pausa tras una semana sin actividad. Si la app se usa a diario no pasa, pero conviene saberlo.
3. **Presencia:** la entrada y salida la marca cada persona. Es un registro, no control de asistencia.
