// Arranque local: npm start (requiere DATABASE_URL)
import app from './app.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Operación de tiendas en http://localhost:${PORT}`);
  console.log(`Entrar: http://localhost:${PORT}/login`);
});
