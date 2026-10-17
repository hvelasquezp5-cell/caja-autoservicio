const $ = (selector) => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';

let moneda = 'Q';
let catalogo = [];
const carrito = new Map(); // clase -> { clase, nombre, precio, cantidad }
let ultimoNodo = null;
let metodo = 'efectivo';
let escaneando = false;
let cobrando = false;

const dinero = (n) => `${moneda}${n.toFixed(2)}`;
const totalCarrito = () => [...carrito.values()].reduce((s, l) => s + l.precio * l.cantidad, 0);
const hora = (iso) => new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { headers: { 'Content-Type': 'application/json' }, ...opciones });
  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    const d = datos?.detail;
    const mensaje = typeof d === 'string' ? d : d?.mensaje
      || (Array.isArray(d) ? 'Los datos enviados no son válidos.' : `El servidor respondió con error ${r.status}.`);
    const error = new Error(mensaje);
    error.detalle = d;
    throw error;
  }
  return datos;
}

function crear(etiqueta, clase, texto) {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
}

/* ------------------------------------------------------------ escaneo */

async function escanear() {
  if (escaneando) return;
  escaneando = true;
  const boton = $('#btn-escanear');
  boton.disabled = true;
  boton.textContent = 'Escaneando…';
  $('#visor').classList.add('escaneando');
  $('#visor-mensaje').hidden = true;

  try {
    const r = await api('/api/escanear', { method: 'POST' });
    mostrarCaptura(r);
    // Cada escaneo suma al ticket; el ticket solo se vacía al pagar o con "Vaciar ticket".
    const nuevas = new Set();
    for (const i of r.items) {
      const linea = carrito.get(i.clase) ?? { clase: i.clase, nombre: i.nombre, precio: i.precio, cantidad: 0 };
      linea.cantidad = Math.min(99, linea.cantidad + i.cantidad);
      carrito.set(i.clase, linea);
      nuevas.add(i.clase);
    }
    ultimoNodo = r.nodo;
    renderTicket(nuevas);
    renderSinPrecio(r.sin_precio);
    renderUltimo(r);
    if (!r.items.length) {
      mostrarMensaje('No se reconoció ningún producto con precio. Acerca los productos a la cámara o mejora la luz.');
    }
  } catch (e) {
    mostrarMensaje(e.message);
    if (e.detalle?.fallidos) renderUltimo({ fallidos: e.detalle.fallidos });
  } finally {
    escaneando = false;
    boton.disabled = false;
    boton.textContent = $('#captura').hasAttribute('hidden') ? 'Escanear productos' : 'Escanear de nuevo';
    $('#visor').classList.remove('escaneando');
  }
}

function mostrarMensaje(texto) {
  const m = $('#visor-mensaje');
  m.textContent = texto;
  m.hidden = false;
}

function mostrarCaptura(r) {
  const svg = $('#captura');
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${r.ancho} ${r.alto}`);

  const imagen = document.createElementNS(SVG, 'image');
  imagen.setAttribute('href', r.imagen);
  imagen.setAttribute('width', r.ancho);
  imagen.setAttribute('height', r.alto);
  svg.append(imagen);

  const tam = Math.max(14, r.alto * 0.035);
  for (const d of r.detecciones) {
    const [x1, y1, x2, y2] = d.caja;
    const color = d.cobrado ? '#f5b400' : '#c9d1d5';
    const g = document.createElementNS(SVG, 'g');

    const rect = document.createElementNS(SVG, 'rect');
    Object.entries({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 4, fill: 'none', stroke: color,
      'stroke-width': Math.max(3, r.alto * 0.006), 'stroke-dasharray': d.cobrado ? '' : '8 6' })
      .forEach(([k, v]) => rect.setAttribute(k, v));

    const texto = `${d.nombre} ${Math.round(d.confianza * 100)}%`;
    const ancho = texto.length * tam * 0.58 + tam * 0.8;
    const yEtiqueta = y1 - tam * 1.5 < 0 ? y1 : y1 - tam * 1.5;
    const fondo = document.createElementNS(SVG, 'rect');
    Object.entries({ x: x1, y: yEtiqueta, width: ancho, height: tam * 1.5, rx: 3, fill: color })
      .forEach(([k, v]) => fondo.setAttribute(k, v));
    const etiqueta = document.createElementNS(SVG, 'text');
    Object.entries({ x: x1 + tam * 0.4, y: yEtiqueta + tam * 1.08, 'font-size': tam, 'font-weight': 700,
      'font-family': 'Archivo, system-ui, sans-serif', fill: '#1b2328' })
      .forEach(([k, v]) => etiqueta.setAttribute(k, v));
    etiqueta.textContent = texto;

    g.append(rect, fondo, etiqueta);
    svg.append(g);
  }

  svg.removeAttribute('hidden'); // en SVG, .hidden no existe: hay que usar el atributo
  $('#vivo').hidden = true;
  $('#btn-vivo').hidden = false;
}

function volverACamara() {
  $('#captura').setAttribute('hidden', '');
  $('#vivo').hidden = false;
  $('#btn-vivo').hidden = true;
  $('#visor-mensaje').hidden = true;
  $('#btn-escanear').textContent = 'Escanear productos';
}

/* ------------------------------------------------------------ ticket */

function renderTicket(animar = new Set()) {
  const lista = $('#lineas');
  lista.replaceChildren();
  let impresas = 0;
  for (const linea of carrito.values()) {
    const li = crear('li', animar.has(linea.clase) ? 'linea impresa' : 'linea');
    if (animar.has(linea.clase)) li.style.animationDelay = `${impresas++ * 70}ms`;
    li.append(
      crear('span', 'linea-nombre', linea.nombre),
      crear('span', 'linea-subtotal', dinero(linea.precio * linea.cantidad)),
      crear('span', 'linea-detalle', `${linea.cantidad} × ${dinero(linea.precio)}`),
    );
    const cantidad = crear('span', 'cantidad');
    const menos = crear('button', '', '−');
    menos.type = 'button';
    menos.setAttribute('aria-label', `Quitar un ${linea.nombre}`);
    menos.onclick = () => cambiarCantidad(linea.clase, -1);
    const mas = crear('button', '', '+');
    mas.type = 'button';
    mas.setAttribute('aria-label', `Agregar un ${linea.nombre}`);
    mas.onclick = () => cambiarCantidad(linea.clase, 1);
    cantidad.append(menos, crear('output', '', linea.cantidad), mas);
    li.append(cantidad);
    lista.append(li);
  }
  lista.querySelector('.impresa')?.scrollIntoView({ block: 'nearest' });

  const total = totalCarrito();
  $('#ticket-vacio').hidden = carrito.size > 0;
  $('#btn-vaciar').hidden = carrito.size === 0;
  $('#total').textContent = dinero(total);
  const pagar = $('#btn-pagar');
  pagar.disabled = carrito.size === 0;
  pagar.textContent = carrito.size ? `Pagar ${dinero(total)}` : 'Pagar';
  $('#t-fecha').textContent = new Date().toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' });
}

function cambiarCantidad(clase, delta) {
  const linea = carrito.get(clase);
  if (!linea) return;
  linea.cantidad = Math.min(99, linea.cantidad + delta);
  if (linea.cantidad <= 0) carrito.delete(clase);
  renderTicket();
}

function agregarManual(clase) {
  const producto = catalogo.find((p) => p.clase === clase);
  if (!producto) return;
  const linea = carrito.get(clase) ?? { clase, nombre: producto.nombre, precio: producto.precio, cantidad: 0 };
  linea.cantidad = Math.min(99, linea.cantidad + 1);
  carrito.set(clase, linea);
  renderTicket();
}

function renderSinPrecio(clases) {
  const aviso = $('#sin-precio');
  aviso.hidden = !clases.length;
  aviso.textContent = clases.length
    ? `También se detectó ${clases.join(', ')}, pero no tiene precio registrado y no se cobró.`
    : '';
}

/* ------------------------------------------------------------ clúster */

function renderUltimo(r) {
  const p = $('#ultimo');
  const fallas = (r.fallidos ?? []).map((f) => `${f.nodo} ${f.error}`);
  if (!r.nodo) {
    p.textContent = `Ningún nodo pudo procesar el escaneo: ${fallas.join('; ')}.`;
  } else {
    const base = `Último escaneo procesado por ${r.nodo} en ${r.ms_total} ms (inferencia ${Math.round(r.ms_inferencia)} ms).`;
    p.textContent = fallas.length ? `${fallas.join('; ')}, se reintentó en ${r.nodo}. ${base}` : base;
  }
  p.classList.toggle('con-falla', fallas.length > 0);
}

async function actualizarEstado() {
  try {
    const { nodos } = await api('/api/estado');
    const lista = $('#nodos');
    lista.replaceChildren(...nodos.map((n) => {
      const estado = n.activo === true ? 'activo' : n.activo === false ? 'caido' : '';
      const li = crear('li', `nodo ${estado} ${n.nombre === ultimoNodo ? 'reciente' : ''}`);
      const detalle = n.activo === true ? `${n.latencia_ms} ms`
        : n.activo === false ? 'sin respuesta' : 'comprobando';
      li.append(
        crear('span', 'nodo-luz'),
        crear('span', 'nodo-nombre', n.nombre),
        crear('span', 'nodo-detalle', `${detalle}, ${n.escaneos} escaneos`),
      );
      li.title = n.error ? `${n.url}: ${n.error}` : n.url;
      return li;
    }));
  } catch {
    $('#nodos').replaceChildren(crear('li', 'nodo caido', 'La caja no responde'));
  }
}

/* ------------------------------------------------------------ pago */

function abrirPago() {
  if (!carrito.size) return;
  $('#paso-pago').hidden = false;
  $('#paso-comprobante').hidden = true;
  $('#pago-error').hidden = true;
  $('#pago-total').textContent = dinero(totalCarrito());
  $('#recibido').value = '';
  elegirMetodo('efectivo');
  renderRapidos();
  $('#dlg-pago').showModal();
  $('#recibido').focus();
}

function elegirMetodo(nuevo) {
  metodo = nuevo;
  document.querySelectorAll('.metodo').forEach((b) => b.setAttribute('aria-checked', b.dataset.metodo === nuevo));
  $('#panel-efectivo').hidden = nuevo !== 'efectivo';
  $('#panel-tarjeta').hidden = nuevo !== 'tarjeta';
  $('#pago-error').hidden = true;
  actualizarCobro();
}

function renderRapidos() {
  const total = totalCarrito();
  const billetes = [5, 10, 20, 50, 100, 200].filter((b) => b > total).slice(0, 3);
  const opciones = [['Exacto', total], ...billetes.map((b) => [dinero(b), b])];
  $('#rapidos').replaceChildren(...opciones.map(([texto, valor]) => {
    const b = crear('button', '', texto);
    b.type = 'button';
    b.onclick = () => { $('#recibido').value = valor.toFixed(2); actualizarCobro(); };
    return b;
  }));
}

function actualizarCobro() {
  const total = totalCarrito();
  const recibido = parseFloat($('#recibido').value);
  $('#cambio').textContent = dinero(Number.isFinite(recibido) && recibido >= total ? recibido - total : 0);
  $('#btn-cobrar').textContent = metodo === 'tarjeta' ? `Cobrar ${dinero(total)} con tarjeta` : `Cobrar ${dinero(total)}`;
}

async function cobrar() {
  if (cobrando) return;
  const total = totalCarrito();
  const recibido = parseFloat($('#recibido').value);
  const error = $('#pago-error');
  if (metodo === 'efectivo' && !(recibido >= total)) {
    error.textContent = `El efectivo recibido debe ser al menos ${dinero(total)}.`;
    error.hidden = false;
    $('#recibido').focus();
    return;
  }

  cobrando = true;
  const boton = $('#btn-cobrar');
  boton.disabled = true;
  error.hidden = true;
  try {
    if (metodo === 'tarjeta') {
      boton.textContent = 'Procesando pago…';
      await new Promise((ok) => setTimeout(ok, 1200));
    }
    const venta = await api('/api/ventas', {
      method: 'POST',
      body: JSON.stringify({
        items: [...carrito.values()].map((l) => ({ clase: l.clase, cantidad: l.cantidad })),
        metodo,
        recibido: metodo === 'efectivo' ? recibido : null,
        nodo: ultimoNodo,
      }),
    });
    mostrarComprobante(venta);
    actualizarVentas();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    cobrando = false;
    boton.disabled = false;
    actualizarCobro();
  }
}

function mostrarComprobante(v) {
  const c = $('#comprobante');
  c.replaceChildren();
  const cabecera = crear('header', 'ticket-cabecera');
  cabecera.append(
    crear('strong', '', $('#t-tienda').textContent),
    crear('span', '', `${$('#t-caja').textContent}, venta ${v.id}`),
    crear('span', '', new Date(v.fecha).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' })),
  );
  const lista = crear('ol', 'lineas');
  for (const l of v.items) {
    const li = crear('li', 'linea');
    li.append(
      crear('span', 'linea-nombre', l.nombre),
      crear('span', 'linea-subtotal', dinero(l.subtotal)),
      crear('span', 'linea-detalle', `${l.cantidad} × ${dinero(l.precio)}`),
    );
    lista.append(li);
  }
  const total = crear('div', 'total');
  total.append(crear('span', '', 'Total'), crear('strong', '', dinero(v.total)));
  c.append(cabecera, lista, total);

  const fila = (a, b) => {
    const p = crear('p', 'comprobante-fila');
    p.append(crear('span', '', a), crear('span', '', b));
    return p;
  };
  if (v.metodo === 'efectivo') {
    c.append(fila('Efectivo', dinero(v.recibido)), fila('Cambio', dinero(v.cambio)));
  } else {
    c.append(fila('Tarjeta (simulada)', `Autorización ${v.autorizacion}`));
  }
  if (v.nodo) c.append(fila('Reconocido por', v.nodo));
  c.append(crear('p', 'comprobante-pie', 'Gracias por su compra'));

  $('#paso-pago').hidden = true;
  $('#paso-comprobante').hidden = false;
  $('#btn-nueva').focus();
}

function nuevaCompra() {
  $('#dlg-pago').close();
  carrito.clear();
  ultimoNodo = null;
  renderTicket();
  renderSinPrecio([]);
  volverACamara();
}

/* ------------------------------------------------------------ historial */

async function actualizarVentas() {
  try {
    const { ventas, total } = await api('/api/ventas');
    $('#ventas-cuenta').textContent = ventas.length;
    $('#historial-total').textContent = dinero(total);
    const lista = $('#historial');
    lista.replaceChildren(...ventas.map((v) => {
      const li = crear('li');
      const articulos = v.items.reduce((s, l) => s + l.cantidad, 0);
      li.append(
        crear('span', 'historial-hora', hora(v.fecha)),
        crear('span', '', `Venta ${v.id}: ${articulos} ${articulos === 1 ? 'artículo' : 'artículos'}, ${v.metodo}`),
        crear('span', 'historial-monto', dinero(v.total)),
      );
      return li;
    }));
    if (!ventas.length) lista.append(crear('li', 'historial-vacio', 'Todavía no hay ventas hoy.'));
  } catch { /* el historial es secundario: si falla, la caja sigue funcionando */ }
}

/* ------------------------------------------------------------ inicio */

async function iniciar() {
  const config = await api('/api/config');
  moneda = config.moneda;
  $('#tienda').textContent = $('#t-tienda').textContent = config.tienda;
  $('#caja').textContent = $('#t-caja').textContent = config.caja;
  document.title = `${config.caja}, ${config.tienda}`;

  catalogo = await api('/api/catalogo');
  $('#agregar').append(...catalogo.map((p) => {
    const o = crear('option', '', `${p.nombre} (${dinero(p.precio)})`);
    o.value = p.clase;
    return o;
  }));

  renderTicket();
  actualizarEstado();
  actualizarVentas();
  setInterval(actualizarEstado, 2000);
}

$('#btn-escanear').onclick = escanear;
$('#btn-vivo').onclick = volverACamara;
$('#btn-pagar').onclick = abrirPago;
$('#btn-vaciar').onclick = () => { carrito.clear(); renderSinPrecio([]); renderTicket(); };
$('#btn-cobrar').onclick = cobrar;
$('#btn-nueva').onclick = nuevaCompra;
$('#btn-imprimir').onclick = () => window.print();
$('#btn-historial').onclick = () => { actualizarVentas(); $('#dlg-historial').showModal(); };
$('#recibido').oninput = actualizarCobro;
$('#recibido').onkeydown = (e) => { if (e.key === 'Enter') cobrar(); };
$('#agregar').onchange = (e) => { agregarManual(e.target.value); e.target.value = ''; };
document.querySelectorAll('.metodo').forEach((b) => { b.onclick = () => elegirMetodo(b.dataset.metodo); });

// La barra espaciadora escanea, salvo que haya un diálogo abierto o el foco esté en un control.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.querySelector('dialog[open]')) return;
  if (e.target.closest('button, input, select, textarea')) return;
  e.preventDefault();
  escanear();
});

iniciar().catch((e) => mostrarMensaje(`No se pudo cargar la caja: ${e.message}`));
