# Polvo — app de Android

Rally online para jugar con amigos. Esta carpeta arma la APK a partir del mismo juego que está publicado en Claude.

- `src/polvo.html` — el juego (copia del que se publica en claude.ai).
- `src/polvo-net.js` — conexión online de la app: Supabase para cuentas, catálogo y pistas; WebRTC (conexión directa entre teléfonos) para la carrera.
- `src/polvo-config.js` — dirección y clave pública de Supabase.
- `supabase/setup.sql` — preparación de la base de datos (se corre una vez en el SQL Editor de Supabase).
- `seed/` — autos y pistas traídos de la versión de Claude; el dueño los importa desde **Cuenta → Importar**.
- `android/` — proyecto de Android (Capacitor).

Cada vez que se sube un cambio a `main`, GitHub compila la APK sola y la publica en **Releases**.
