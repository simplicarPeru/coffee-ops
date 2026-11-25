// Configuración de la operación.
// Edita aquí tiendas, horarios límite y puntos del checklist.
// Para agregar tiendas (hasta 18), añade una entrada a STORES.

export const TIMEZONE = 'America/Lima';

export const STORES = [
  { id: 'tienda-01', name: 'Tienda 01' },
  { id: 'tienda-02', name: 'Tienda 02' },
  { id: 'tienda-03', name: 'Tienda 03' },
  { id: 'tienda-04', name: 'Tienda 04' },
  { id: 'tienda-05', name: 'Tienda 05' },
  { id: 'tienda-06', name: 'Tienda 06' },
  { id: 'tienda-07', name: 'Tienda 07' },
  { id: 'tienda-08', name: 'Tienda 08' },
  { id: 'tienda-09', name: 'Tienda 09' },
  { id: 'tienda-10', name: 'Tienda 10' },
  { id: 'tienda-11', name: 'Tienda 11' },
  { id: 'tienda-12', name: 'Tienda 12' },
];

// type:
//  - 'check': el personal la marca como hecha (sí/no)
//  - 'photo': se completa al subir al menos una foto
export const MOMENTS = {
  opening: {
    label: 'Apertura',
    deadline: '07:00', // hora de apertura por defecto (editable por tienda)
    items: [
      { id: 'caja-apertura', label: 'Caja abierta: foto de la pantalla del sistema', type: 'photo' },
      { id: 'tablet-rappi', label: 'Tablet de Rappi: foto', type: 'photo' },
      { id: 'vitrina', label: 'Vitrina: foto', type: 'photo' },
      { id: 'fachada', label: 'Afuera de la tienda: foto', type: 'photo' },
      { id: 'calib-inicio', label: 'Calibración de inicio (espresso y molino): foto del registro', type: 'photo' },
      { id: 'equipos-on', label: 'Máquina, molino y refrigeración encendidos', type: 'check' },
      { id: 'personal', label: 'Personal completo, con uniforme y cofia', type: 'check' },
    ],
  },
  midday: {
    label: 'Mediodía',
    deadline: '13:30',
    items: [
      { id: 'calib-medio', label: 'Calibración de mediodía: foto del registro', type: 'photo' },
      { id: 'limpieza', label: 'Barra, mesas y zona de atención limpias y ordenadas', type: 'check' },
      { id: 'banos', label: 'Baños limpios y con insumos', type: 'check' },
      { id: 'vitrina-medio', label: 'Vitrina completa, rotulada y lista: foto', type: 'photo' },
      { id: 'insumos', label: 'Insumos listos y dentro de fecha', type: 'check' },
      { id: 'tablet-rappi-medio', label: 'Tablet de Rappi revisada: foto', type: 'photo' },
    ],
  },
  closing: {
    label: 'Cierre',
    deadline: '23:30',
    items: [
      { id: 'arqueo', label: 'Arqueo de caja: foto del cierre', type: 'photo' },
      { id: 'cierre-sistema', label: 'Cierre hecho en el sistema Restaurant', type: 'check' },
      { id: 'equipos-off', label: 'Equipos apagados y limpios', type: 'check' },
      { id: 'piso', label: 'Piso, vitrinas y vidrios sin residuos', type: 'check' },
      { id: 'insumos-cierre', label: 'Insumos guardados correctamente', type: 'check' },
      { id: 'pedidos-pendientes', label: 'Pedidos de delivery y Rappi sin pendientes', type: 'check' },
      { id: 'fachada-cierre', label: 'Afuera de la tienda cerrada: foto', type: 'photo' },
    ],
  },
};

export const MOMENT_ORDER = ['opening', 'midday', 'closing'];
