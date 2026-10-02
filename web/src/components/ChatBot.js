"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  Copy,
  Crosshair,
  Maximize2,
  MessageSquare,
  Mic,
  Minus,
  Pin,
  PinOff,
  Send,
  ThumbsDown,
  ThumbsUp,
  X
} from "lucide-react";

const BUBBLE = 56;
const MARGIN = 20;
const PANEL_W = 380;
const PANEL_MAX_H = 640;
const DRAG_SLOP = 4;
// Debe coincidir con la animación `cb-out` de globals.css.
const CLOSE_MS = 160; 

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const STREAM_ENDPOINT = `${API_URL}/api/v1/openai/chat/stream`;
const VOTO_ENDPOINT = (id) => `${API_URL}/api/v1/feedback/${id}`;
const HEALTH_ENDPOINT = `${API_URL}/health`;

// Cada cuánto se vuelve a comprobar el backend. También con el chat cerrado,
// porque el globo muestra su propio punto de estado; ahí se espacía, que nadie
// está leyendo la respuesta en ese momento.
const PING_MS = 30000;
const PING_CERRADO_MS = 120000;
// Si el backend está caído, la petición muere por timeout de red y eso tarda.
// Con un corte propio el aviso aparece rápido en vez de dejar "Conectando…".
const PING_TIMEOUT_MS = 5000;

// Lo que dura el «Gracias» tras calificar, antes de quitarse solo.
const GRACIAS_MS = 3000;

// Cada motivo se arregla en un lugar distinto: "el dato está mal" apunta al ETL
// o al diccionario de códigos; los otros tres son fallas del agente.
// Los ids viajan tal cual al backend y son el CHECK de la tabla: cambiar uno
// aquí sin cambiarlo allá hace que el voto se rechace con un 422.
const MOTIVOS = [
  { id: "dato_incorrecto", txt: "El dato está mal" },
  { id: "no_entendio", txt: "No entendió" },
  { id: "filtro_incorrecto", txt: "Filtró mal el mapa" },
  { id: "mal_redactado", txt: "Mal redactado" }
];

const CHIPS = [
  { rotulo: "Municipios críticos", pregunta: "¿Qué municipios tienen peor efectividad?" },
  { rotulo: "Por qué no se suspende", pregunta: "¿Por qué no se pudo suspender y en qué municipios pasa más?" },
  { rotulo: "Rendimiento por funcionario", pregunta: "¿Qué funcionarios tienen mejor y peor efectividad?" },
];

const SALUDO = {
  role: "assistant",
  content: "Hola. En qué puedo ayudarte hoy?"
};

// Se van mostrando en orden mientras no llegue el primer trozo de respuesta.
const PENSANDO = [
  "Pensando…",
  "Analizando la consulta…",
  "Revisando los datos…",
  "Cruzando los datos del mapa…",
  "Redactando la respuesta…",
  "Sigo en ello, dame un momento…"
];
const PENSANDO_MS = 2800;

// `.` no cruza saltos de línea a propósito: si el modelo deja un ** suelto, se
// come una palabra y no el resto del mensaje.
const NEGRITA = /\*\*(.+?)\*\*/g;

// El prompt le prohíbe los encabezados, pero a veces se le escapan y en la
// burbuja se veían los `###` en crudo. Aquí se degradan a negrita en vez de
// renderizarlos: en 300 píxeles de ancho un encabezado no titula nada.
const ENCABEZADO = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm;

/**
 * Pone en negrita los `**...**` que devuelve el modelo.
 *
 * Devuelve nodos de React, nunca HTML: el texto viene de un modelo de lenguaje
 * y con `dangerouslySetInnerHTML` cualquier etiqueta que escupiera se ejecutaría.
 * Mientras llega el streaming, un `**` sin cerrar se ve literal hasta que cierra.
 */
function conNegritas(crudo) {
  // Los encabezados pasan a negrita antes del recorrido, para no duplicar la
  // lógica de troceado: a partir de aquí solo existe `**`.
  const texto = crudo.replace(ENCABEZADO, "**$1**");
  const nodos = [];
  let cursor = 0;

  for (const m of texto.matchAll(NEGRITA)) {
    if (m.index > cursor) nodos.push(texto.slice(cursor, m.index));
    nodos.push(<strong key={m.index}>{m[1]}</strong>);
    cursor = m.index + m[0].length;
  }
  if (!nodos.length) return texto;
  if (cursor < texto.length) nodos.push(texto.slice(cursor));
  return nodos;
}

/**
 * Hora local de un mensaje, "HH:MM".
 *
 * Se guarda la marca de tiempo y se formatea al pintar, no al crear: así la hora
 * sale en el huso y el formato de quien mira, y no en el de quien la escribió.
 *
 * El saludo inicial no lleva marca a propósito. El panel se renderiza también en
 * el servidor, y una hora calculada durante el render no coincidiría con la del
 * navegador: React lo cantaría como desajuste de hidratación.
 */
function horaDe(marca) {
  if (!marca) return null;
  return new Date(marca).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/** Convierte el filtro del backend en una línea legible. Null si no filtra nada. */
function resumirFiltro(accion) {
  const partes = [
    accion.municipio,
    accion.zona,
    accion.causal,
    accion.clase_servicio,
    accion.ciclo && `Ciclo ${accion.ciclo}`,
    accion.meses?.join(", ")
  ].filter(Boolean);
  return partes.length ? partes.join(" · ") : null;
}

/**
 * Barra de acciones bajo una respuesta: copiar, buena y mala.
 *
 * La mala pregunta *por qué* en un modal. Sin ese motivo un «no sirvió» no dice
 * si falló el dato, la comprensión o la redacción, y cada una se corrige en un
 * sitio distinto.
 */
function Acciones({ texto, voto, onVotar }) {
  const [modal, setModal] = useState(false);
  const [copiado, setCopiado] = useState(false);
  // El "Gracias" es local y no se deduce de `voto`: atado al voto reaparecería
  // en cada repintado de la lista, y lo que confirma es el clic, no el estado.
  const [gracias, setGracias] = useState(false);
  const graciasRef = useRef(null);

  const agradecer = useCallback(() => {
    clearTimeout(graciasRef.current);
    setGracias(true);
    graciasRef.current = setTimeout(() => setGracias(false), GRACIAS_MS);
  }, []);

  const callar = useCallback(() => {
    clearTimeout(graciasRef.current);
    setGracias(false);
  }, []);

  useEffect(() => () => clearTimeout(graciasRef.current), []);

  const copiar = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS) no hay nada que hacer aquí:
      // el botón simplemente no confirma y el usuario puede seleccionar a mano.
    }
  }, [texto]);

  return (
    <>
      <div className="cb-acts">
        <button
          type="button"
          onClick={copiar}
          title={copiado ? "Copiado" : "Copiar respuesta"}
          aria-label="Copiar la respuesta"
        >
          {copiado ? (
            <Check size={13} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Copy size={13} strokeWidth={2.2} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className={voto === "util" ? "votado" : ""}
          aria-pressed={voto === "util"}
          onClick={() => {
            // Segundo clic sobre el mismo pulgar: se retira el voto.
            if (voto === "util") {
              callar();
              onVotar(null);
              return;
            }
            onVotar("util");
            agradecer();
          }}
          title={voto === "util" ? "Quitar la calificación" : "Buena respuesta"}
          aria-label={voto === "util" ? "Quitar la calificación" : "Buena respuesta"}
        >
          <ThumbsUp size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={voto === "inutil" ? "votado" : ""}
          aria-pressed={voto === "inutil"}
          onClick={() => setModal(true)}
          title="Mala respuesta"
          aria-label="Mala respuesta"
        >
          <ThumbsDown size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>

        {gracias && <span className="cb-acts-ok">Gracias</span>}
      </div>

      {modal && (
        <ModalComentarios
          onCerrar={() => setModal(false)}
          onEnviar={(motivo, comentario) => {
            setModal(false);
            onVotar("inutil", motivo, comentario);
            agradecer();
          }}
        />
      )}
    </>
  );
}

/** Modal de «qué falló». Los motivos no son genéricos: cada uno se arregla en un
 *  sitio distinto (el dato es el ETL o el diccionario; el resto, el agente). */
function ModalComentarios({ onCerrar, onEnviar }) {
  const [motivo, setMotivo] = useState(null);
  const [comentario, setComentario] = useState("");

  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onCerrar();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onCerrar]);

  return (
    <div className="cb-modal-bg" onPointerDown={onCerrar}>
      <div
        className="cb-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Compartir comentarios"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="cb-modal-h">
          <b>Compartir comentarios</b>
          <button type="button" onClick={onCerrar} aria-label="Cerrar">
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <div className="cb-modal-chips">
          {MOTIVOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={motivo === m.id ? "on" : ""}
              aria-pressed={motivo === m.id}
              onClick={() => setMotivo(motivo === m.id ? null : m.id)}
            >
              {m.txt}
            </button>
          ))}
        </div>

        <textarea
          value={comentario}
          onChange={(e) => setComentario(e.target.value)}
          aria-label="Detalle del problema"
          rows={3}
          placeholder={
            motivo === "dato_incorrecto"
              ? "¿Qué debería decir?"
              : "Compartir detalles (opcional)"
          }
        />

        <div className="cb-modal-acts">
          <button
            type="button"
            className="primary"
            disabled={!motivo}
            onClick={() => onEnviar(motivo, comentario)}
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Etiqueta de espera. Avanza por las frases y se queda en la última. */
function Pensando() {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (i >= PENSANDO.length - 1) return;
    const id = setTimeout(() => setI((n) => n + 1), PENSANDO_MS);
    return () => clearTimeout(id);
  }, [i]);

  return (
    <div className="cb-msg bot cb-thinking">
      <span key={i} className="cb-thinking-t">
        {PENSANDO[i]}
      </span>
    </div>
  );
}

/**
 * @param {{
 *   onAccion?: (accion: object) => void,
 *   vista?: () => object | null
 * }} props
 *   `onAccion` recibe los filtros que el backend pide aplicar al mapa.
 *   `vista` es una función —no un objeto— para leer los filtros en el momento de
 *   enviar: si fuera un valor, el envío usaría el de la última renderización.
 */
export default function ChatBot({ onAccion, vista }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");

  const [messages, setMessages] = useState([SALUDO]);
  // Agrupa el feedback de un mismo hilo. Se crea al primer envío y vive lo que
  // viva el componente: el backend no guarda la conversación, así que si no lo
  // pone el cliente no lo pone nadie.
  const conversacionRef = useRef(null);
  const [busy, setBusy] = useState(false);
  // "probando" mientras no se sabe: antes decía "En línea" desde el primer
  // render, con lo cual afirmaba algo que nadie había comprobado.
  const [conexion, setConexion] = useState("probando");
  const [filtroAplicado, setFiltroAplicado] = useState(null);

  const [escuchando, setEscuchando] = useState(false);
  const [soportaVoz, setSoportaVoz] = useState(false);
  const [errorVoz, setErrorVoz] = useState(null);

  const [panelPos, setPanelPos] = useState(null);
  const [panelDragging, setPanelDragging] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [minimized, setMinimized] = useState(false);

  const [place, setPlace] = useState(() => {
    if (typeof window === "undefined") return null;
    return { x: window.innerWidth - BUBBLE - MARGIN, y: window.innerHeight - BUBBLE - MARGIN };
  });

  const anclaX = panelPos ? panelPos.x + PANEL_W / 2 : place ? place.x + BUBBLE / 2 : null;
  const side =
    anclaX !== null && typeof window !== "undefined" && anclaX < window.innerWidth / 2
      ? "left"
      : "right";

  const launcherRef = useRef(null);
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const abortRef = useRef(null);
  const closeTimer = useRef(null);
  const dragRef = useRef({ dx: 0, dy: 0, ox: 0, oy: 0, moved: false });
  const panelDragRef = useRef({ dx: 0, dy: 0, w: 0, h: 0 });

  const vozRef = useRef(null);
  const previoRef = useRef("");

  // En un ref para que `send` no se recree cada vez que cambie el callback.
  const accionRef = useRef(onAccion);
  const vistaRef = useRef(vista);
  useEffect(() => {
    accionRef.current = onAccion;
    vistaRef.current = vista;
  }, [onAccion, vista]);

  // El texto y el color del punto salen del mismo sitio para que no puedan
  // contradecirse: antes el punto era blanco fijo y decía "en línea" siempre.
  const estadoConexion =
    conexion === "caido"
      ? { clase: "off", texto: "Sin conexión con el servidor" }
      : busy
        ? { clase: "on", texto: "Escribiendo…" }
        : conexion === "probando"
          ? { clase: "wait", texto: "Conectando…" }
          : { clase: "on", texto: "En línea" };

  // Comprueba el backend periódicamente, abierto o cerrado. Sin esto el
  // indicador solo se enteraba de una caída cuando un envío fallaba, así que con
  // el servidor apagado seguía diciendo "En línea".
  // Depende de `open` para reajustar el ritmo, y de paso vuelve a comprobar al
  // abrir, que es justo cuando alguien va a mirar el estado.
  useEffect(() => {
    let cancelado = false;
    let timer = null;

    const comprobar = async () => {
      const controller = new AbortController();
      const corte = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      try {
        const res = await fetch(HEALTH_ENDPOINT, {
          signal: controller.signal,
          cache: "no-store"
        });
        if (!cancelado) setConexion(res.ok ? "ok" : "caido");
      } catch {
        if (!cancelado) setConexion("caido");
      } finally {
        clearTimeout(corte);
        if (!cancelado) timer = setTimeout(comprobar, open ? PING_MS : PING_CERRADO_MS);
      }
    };

    comprobar();
    return () => {
      cancelado = true;
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  // El reconocimiento de voz se crea una vez. En Firefox no existe y el botón
  // simplemente no se dibuja: un botón permanentemente inhabilitado no ayuda.
  useEffect(() => {
    const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Reconocimiento) return;

    const rec = new Reconocimiento();
    rec.lang = "es-CO";
    rec.continuous = false;
    rec.interimResults = true; // el texto aparece mientras hablas

    rec.onresult = (e) => {
      let dicho = "";
      for (let i = 0; i < e.results.length; i++) dicho += e.results[i][0].transcript;
      setDraft(`${previoRef.current} ${dicho}`.trim());
    };
    rec.onerror = (e) => {
      setEscuchando(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setErrorVoz("Falta el permiso del micrófono.");
      } else if (e.error === "no-speech") {
        setErrorVoz("No escuché nada.");
      } else if (e.error !== "aborted") {
        setErrorVoz("No pude usar el micrófono.");
      }
    };
    rec.onend = () => setEscuchando(false);

    vozRef.current = rec;
    setSoportaVoz(true);
    return () => {
      rec.onresult = rec.onerror = rec.onend = null;
      rec.abort();
    };
  }, []);

  const alternarVoz = useCallback(() => {
    const rec = vozRef.current;
    if (!rec) return;
    if (escuchando) {
      rec.stop();
      return;
    }
    setErrorVoz(null);
    previoRef.current = draft;
    try {
      rec.start();
      setEscuchando(true);
    } catch {
      // start() lanza si ya estaba activo; el estado se corrige con onend.
    }
  }, [escuchando, draft]);

  // Cerrar o plegar el panel con el micrófono abierto lo dejaría grabando.
  useEffect(() => {
    if (!open || minimized) vozRef.current?.abort();
  }, [open, minimized]);

  const openPanel = useCallback(() => {
    clearTimeout(closeTimer.current);
    setClosing(false);
    setOpen(true);
  }, []);

  /** Marca la salida y desmonta cuando la animación termina, no antes. */
  const closePanel = useCallback(() => {
    setClosing(true);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
  }, []);

  /** La burbuja se queda donde la sueltes; solo se impide que salga del viewport. */
  const clamp = (x, y) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: Math.min(Math.max(x, MARGIN), w - BUBBLE - MARGIN),
      y: Math.min(Math.max(y, MARGIN), h - BUBBLE - MARGIN)
    };
  };

  /** Igual que `clamp`, pero para una caja del tamaño del panel. */
  const clampPanel = (x, y, w, h) => ({
    x: Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN)),
    y: Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN))
  });

  useEffect(() => {
    const onResize = () => {
      setPlace((prev) => (prev ? clamp(prev.x, prev.y) : prev));
      setPanelPos((prev) => {
        const el = panelRef.current;
        if (!prev || !el) return prev;
        const r = el.getBoundingClientRect();
        return clampPanel(prev.x, prev.y, r.width, r.height);
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePanel]);

  // Corta el streaming y el temporizador de cierre si el componente se desmonta.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      clearTimeout(closeTimer.current);
    },
    []
  );

  // El hilo siempre pegado abajo mientras entra texto.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, minimized]);

  /** Añade texto al último mensaje del asistente, que es el que se está escribiendo. */
  const appendToLast = useCallback((delta) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
  }, []);

  const votar = useCallback((indice, interaccionId, voto, motivo = null, comentario = "") => {
    setMessages((prev) =>
      prev.map((m, i) => (i === indice ? { ...m, voto, motivo, comentario } : m))
    );

    // Sin id el backend no pudo registrar el turno; el pulgar se queda pintado
    // pero no hay contra qué votar. Se calla: al usuario no le sirve de nada
    // enterarse de que la telemetría está caída.
    if (!interaccionId) return;

    fetch(VOTO_ENDPOINT(interaccionId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voto, motivo, comentario })
    }).catch(() => {});
  }, []);

  const send = useCallback(
    async (text) => {
      const pregunta = text.trim();
      if (!pregunta || busy) return;

      // Lo que viaja al backend: el historial más la pregunta nueva.
      const marca = Date.now();
      const historial = [...messages, { role: "user", content: pregunta, hora: marca }];
      setMessages([...historial, { role: "assistant", content: "", hora: marca }]);
      setDraft("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // randomUUID solo existe en contexto seguro (https o localhost); el
      // respaldo evita que el chat reviente en un despliegue por http plano.
      conversacionRef.current ??=
        crypto.randomUUID?.() ??
        "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
          (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
        );

      try {
        const res = await fetch(STREAM_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: historial.map(({ role, content }) => ({ role, content })),
            vista: vistaRef.current?.() ?? null,
            conversacion_id: conversacionRef.current
          }),
          signal: controller.signal
        });

        if (!res.ok || !res.body) {
          throw new Error(`El servidor respondió ${res.status}`);
        }

        // Un envío que sale bien es la mejor prueba de que el backend responde,
        // y llega antes que el siguiente sondeo.
        setConexion("ok");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // SSE: los eventos llegan separados por una línea en blanco.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const eventos = buffer.split("\n\n");
          buffer = eventos.pop() ?? "";

          for (const evento of eventos) {
            const linea = evento.trim();
            if (!linea.startsWith("data:")) continue;

            const dato = linea.slice(5).trim();
            if (dato === "[DONE]") continue;

            const payload = JSON.parse(dato);
            if (payload.error) throw new Error(payload.error);
            if (payload.delta) appendToLast(payload.delta);
            // Llega al final del flujo: es lo que habilita los pulgares de esta
            // respuesta. Si no llega, el turno no quedó guardado.
            if (payload.interaccion_id) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                next[next.length - 1] = { ...last, interaccionId: payload.interaccion_id };
                return next;
              });
            }
            // El backend resolvió una consulta: que el mapa se filtre solo.
            if (payload.accion) {
              accionRef.current?.(payload.accion);
              // Se guarda la acción completa, no solo su resumen: el chip la
              // vuelve a aplicar si el usuario limpió los filtros a mano.
              const resumen = resumirFiltro(payload.accion);
              if (resumen) setFiltroAplicado({ accion: payload.accion, resumen });
            }
          }
        }
      } catch (err) {
        if (err.name === "AbortError") return;
        setConexion("caido");
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          // Si no alcanzó a llegar nada, la burbuja vacía se convierte en el aviso.
          next[next.length - 1] = {
            ...last,
            content: last.content || `No pude responder: ${err.message}.`
          };
          return next;
        });
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [appendToLast, busy, messages]
  );

  const onPointerDown = useCallback((e) => {
    if (e.button != null && e.button !== 0) return;
    const el = launcherRef.current;
    if (!el) return;
    // Se parte de la caja real: mientras está indexada, el transform la desplaza.
    const r = el.getBoundingClientRect();
    dragRef.current = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      ox: e.clientX,
      oy: e.clientY,
      moved: false
    };
    el.setPointerCapture(e.pointerId);
    setPlace({ x: r.left, y: r.top });
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e) => {
      if (!dragging) return;
      const d = dragRef.current;
      if (!d.moved && (Math.abs(e.clientX - d.ox) > DRAG_SLOP || Math.abs(e.clientY - d.oy) > DRAG_SLOP)) {
        d.moved = true;
      }
      setPlace(clamp(e.clientX - d.dx, e.clientY - d.dy));
    },
    [dragging]
  );

  const endDrag = useCallback((e) => {
    const el = launcherRef.current;
    if (el && e.pointerId != null && el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
    if (!dragRef.current.moved) openPanel();
  }, [openPanel]);

  // --- Arrastre del panel abierto, tomándolo por la cabecera ------------------

  const onHeadPointerDown = useCallback(
    (e) => {
      if (pinned || (e.button != null && e.button !== 0)) return;
      // Los botones de la cabecera no arrastran: son clics.
      if (e.target.closest("button")) return;

      const el = panelRef.current;
      if (!el) return;

      const r = el.getBoundingClientRect();
      panelDragRef.current = {
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        w: r.width,
        h: r.height
      };
      // Fija la posición actual antes de moverla: hasta ahora era automática.
      setPanelPos({ x: r.left, y: r.top });
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanelDragging(true);
    },
    [pinned]
  );

  const onHeadPointerMove = useCallback(
    (e) => {
      if (!panelDragging) return;
      const d = panelDragRef.current;
      setPanelPos(clampPanel(e.clientX - d.dx, e.clientY - d.dy, d.w, d.h));
    },
    [panelDragging]
  );

  const endHeadDrag = useCallback((e) => {
    const el = e.currentTarget;
    if (el && e.pointerId != null && el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    setPanelDragging(false);
  }, []);

  /** Al plegar, congela la posición actual para que la barra no salte. */
  const toggleMinimized = useCallback(() => {
    setPanelPos((prev) => {
      if (prev) return prev;
      const r = panelRef.current?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top } : prev;
    });
    setMinimized((m) => !m);
  }, []);

  const panelStyle = () => {
    if (typeof window === "undefined") return { right: MARGIN, bottom: MARGIN };

    const w = window.innerWidth;
    const h = window.innerHeight;
    const width = Math.min(PANEL_W, w - MARGIN * 2);
    const height = Math.min(PANEL_MAX_H, h - MARGIN * 2);
    // Plegado: la altura la marca la cabecera, así que se deja libre.
    const size = { width, height: minimized ? "auto" : height };

    if (panelPos) return { left: panelPos.x, top: panelPos.y, ...size };
    if (!place) return { right: MARGIN, bottom: MARGIN, ...size };

    const top = Math.min(Math.max(place.y + BUBBLE / 2 - height / 2, MARGIN), h - height - MARGIN);
    const left = side === "left" ? MARGIN : w - width - MARGIN;
    return { left, top, ...size };
  };

  const launcherStyle = place
    ? { left: place.x, top: place.y }
    : { right: MARGIN, bottom: MARGIN };

  const esperandoPrimerTrozo = busy && messages[messages.length - 1]?.content === "";

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          className={`cb-launcher ${dragging ? "dragging" : ""}`}
          style={launcherStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label="Abrir el asistente"
          title="Asistente ElectroHuila"
        >
          <MessageSquare size={22} strokeWidth={2} aria-hidden="true" />
          <span
            className={`cb-launcher-dot cb-dot-${estadoConexion.clase}`}
            aria-hidden="true"
          ></span>
        </button>
      )}

      {open && (
        <section
          ref={panelRef}
          className={`cb-panel ${side === "left" ? "from-l" : "from-r"} ${
            closing ? "closing" : ""
          } ${minimized ? "min" : ""}`}
          style={panelStyle()}
          role="dialog"
          aria-label="Asistente ElectroHuila"
        >
          <header
            className={`cb-head ${pinned ? "pinned" : ""} ${panelDragging ? "dragging" : ""}`}
            onPointerDown={onHeadPointerDown}
            onPointerMove={onHeadPointerMove}
            onPointerUp={endHeadDrag}
            onPointerCancel={endHeadDrag}
            title={pinned ? "Fijado en su sitio" : "Arrástrame para mover el asistente"}
          >
            <span className="cb-head-ic" aria-hidden="true">
              <Bot size={18} strokeWidth={2} />
            </span>
            <div className="cb-head-t">
              <b>Asistente ElectroHuila</b>
              {/* El estado es el del backend, no el del navegador: "Escribiendo…"
                  solo se muestra si además hay conexión comprobada. */}
              <span role="status">
                <i className={`cb-live cb-live-${estadoConexion.clase}`} aria-hidden="true"></i>
                {estadoConexion.texto}
              </span>
            </div>

            <div className="cb-head-acts">
              <button
                type="button"
                className={`cb-x ${pinned ? "on" : ""}`}
                onClick={() => setPinned((p) => !p)}
                aria-pressed={pinned}
                aria-label={pinned ? "Soltar el asistente" : "Fijar el asistente"}
                title={pinned ? "Soltar: vuelve a moverse" : "Fijar: no se podrá mover"}
              >
                {pinned ? (
                  <PinOff size={13} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <Pin size={13} strokeWidth={2.2} aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className="cb-x"
                onClick={toggleMinimized}
                aria-expanded={!minimized}
                aria-label={minimized ? "Restaurar el asistente" : "Minimizar el asistente"}
                title={minimized ? "Restaurar" : "Minimizar"}
              >
                {minimized ? (
                  <Maximize2 size={12} strokeWidth={2.4} aria-hidden="true" />
                ) : (
                  <Minus size={14} strokeWidth={2.6} aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className="cb-x"
                onClick={closePanel}
                aria-label="Cerrar el asistente"
                title="Cerrar"
              >
                <X size={14} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
          </header>

          {!minimized && (
            <>
              <div className="cb-body" ref={bodyRef} aria-live="polite">
                {messages.length === 1 && (
                  <div className="cb-chips">
                    {CHIPS.map((c) => (
                      <button
                        key={c.rotulo}
                        type="button"
                        className="cb-chip"
                        disabled={busy}
                        onClick={() => send(c.pregunta)}
                        title={c.pregunta}
                      >
                        {c.rotulo}
                      </button>
                    ))}
                  </div>
                )}

                {messages.map((m, i) => {
                  const ultimo = i === messages.length - 1;
                  if (ultimo && esperandoPrimerTrozo) return <Pensando key={i} />;
                  // El saludo (índice 0) no es una respuesta: no hay qué calificar.
                  const calificable =
                    m.role === "assistant" && i > 0 && !(ultimo && busy);
                  return (
                    <React.Fragment key={i}>
                      <div className={`cb-msg ${m.role === "user" ? "me" : "bot"}`}>
                        {conNegritas(m.content)}
                      </div>
                      {m.hora && (
                        <time
                          className={`cb-hora ${m.role === "user" ? "me" : "bot"}`}
                          dateTime={new Date(m.hora).toISOString()}
                        >
                          {horaDe(m.hora)}
                        </time>
                      )}
                      {calificable && (
                        <Acciones
                          texto={m.content}
                          voto={m.voto}
                          onVotar={(v, mo, co) => votar(i, m.interaccionId, v, mo, co)}
                        />
                      )}
                    </React.Fragment>
                  );
                })}

                {filtroAplicado && (
                  <button
                    type="button"
                    className="cb-filtro"
                    onClick={() => accionRef.current?.(filtroAplicado.accion)}
                    title="Volver a aplicar este filtro en el mapa"
                    aria-label={`Volver a aplicar el filtro: ${filtroAplicado.resumen}`}
                  >
                    <Crosshair size={12} strokeWidth={2.2} aria-hidden="true" />
                    <span>
                      Mapa filtrado: <b>{filtroAplicado.resumen}</b>
                    </span>
                  </button>
                )}
              </div>

              <footer className="cb-foot">
                <form
                  className="cb-input"
                  onSubmit={(e) => {
                    e.preventDefault();
                    vozRef.current?.abort();
                    send(draft);
                  }}
                >
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      if (errorVoz) setErrorVoz(null); // si ya está escribiendo, sobra el aviso
                    }}
                    placeholder={
                      escuchando ? "Escuchando…" : "¿Cómo puedo ayudarte hoy?"
                    }
                    aria-label="Consulta para el asistente"
                    disabled={busy}
                  />

                  {soportaVoz && (
                    <button
                      type="button"
                      className={`cb-mic ${escuchando ? "on" : ""}`}
                      onClick={alternarVoz}
                      disabled={busy}
                      aria-pressed={escuchando}
                      aria-label={escuchando ? "Detener el dictado" : "Dictar por voz"}
                      title={escuchando ? "Detener" : "Dictar por voz"}
                    >
                      <Mic size={15} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  )}

                  <button
                    type="submit"
                    className="cb-send"
                    disabled={busy || !draft.trim()}
                    aria-label="Enviar consulta"
                  >
                    <Send size={15} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </form>
                <p className={`cb-legal ${errorVoz ? "err" : ""}`}>
                  {errorVoz || "Las respuestas las genera un modelo IA. Verifica antes de operar."}
                </p>
              </footer>
            </>
          )}
        </section>
      )}
    </>
  );
}
