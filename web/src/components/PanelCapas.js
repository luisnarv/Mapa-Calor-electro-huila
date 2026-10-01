"use client";

/**
 * El panel de capas, la leyenda y el indicador de cobertura.
 *
 * Tres bloques, en el mismo orden que el visor de referencia:
 *
 *  1. **Registros a mostrar** — un filtro por cada resultado del diccionario
 *     oficial, agrupados por grupo operativo. No hay un interruptor general:
 *     desmarcarlos todos ya deja el mapa vacío, así que una casilla más solo
 *     daría dos formas de hacer lo mismo.
 *  2. **Cómo dibujarlos** — marcadores, mapa de calor, puntos sueltos, y el par
 *     GPS real / ubicación aproximada, que filtra según lo fina que sea la
 *     coordenada.
 *  3. **Límites oficiales** y la leyenda del índice de riesgo.
 *
 * Al final, la cobertura: cuántos registros están ubicados, con qué precisión y
 * cuántos quedaron fuera. Va aquí y no escondido en un log porque es lo primero
 * que hay que saber para leer el mapa sin engañarse.
 */

import { ChevronRight } from "lucide-react";

import { useTheme } from "@/lib/tema";

export default function PanelCapas({
  st,
  dim,
  onFilterChange,
  colapsado,
  onColapsar,
  cobertura
}) {
  const { palette: P } = useTheme();

  const casillaResultado = (i) => (
    <label className="lay" key={dim.estados[i]}>
      <input
        type="checkbox"
        checked={st.est[i]}
        onChange={(e) => {
          const est = [...st.est];
          est[i] = e.target.checked;
          onFilterChange("est", est);
        }}
      />
      <span className="sw" style={{ background: P.st[dim.estadoGrupo[i]] }} />
      {dim.estados[i]}
    </label>
  );

  // Los resultados ya vienen ordenados por grupo desde el ETL, así que basta
  // con recorrerlos e ir abriendo un encabezado cada vez que cambia el grupo.
  const porGrupo = dim.grupos.map((_, g) => ({
    etiqueta: dim.grupoEtiqueta[g],
    indices: dim.estados.map((_, i) => i).filter((i) => dim.estadoGrupo[i] === g)
  })).filter((g) => g.indices.length);

  const marcarGrupo = (indices, valor) => {
    const est = [...st.est];
    indices.forEach((i) => { est[i] = valor; });
    onFilterChange("est", est);
  };

  const casillaCapa = (clave, texto, swatch) => (
    <label className="lay">
      <input
        type="checkbox"
        checked={st.layers[clave]}
        onChange={(e) => onFilterChange("layers", { ...st.layers, [clave]: e.target.checked })}
      />
      {swatch && <span className="sw" style={{ background: swatch }} />}
      {texto}
    </label>
  );

  const n0 = (v) => (v ?? 0).toLocaleString("es-CO");
  const pct = (v) =>
    cobertura?.total ? `${((v / cobertura.total) * 100).toFixed(1).replace(".", ",")} %` : "";

  return (
    <div id="layers" style={colapsado ? { width: "auto", minWidth: 0 } : undefined}>
      <button
        type="button"
        className="lay-toggle"
        onClick={onColapsar}
        title={colapsado ? "Mostrar capas" : "Ocultar capas"}
        aria-expanded={!colapsado}
        style={{ margin: colapsado ? 0 : "0 0 8px" }}
      >
        <span>Capas</span>
        <span className={`chev ${colapsado ? "" : "abierto"}`} aria-hidden="true">
          <ChevronRight size={13} strokeWidth={2.4} />
        </span>
      </button>

      {!colapsado && (
        <>
          <h4>Resultado de la orden</h4>
          {porGrupo.map((g) => {
            const todos = g.indices.every((i) => st.est[i]);
            return (
              <div key={g.etiqueta} className="grp">
                <button
                  type="button"
                  className="grp-h"
                  onClick={() => marcarGrupo(g.indices, !todos)}
                  title={todos ? "Quitar todo el grupo" : "Marcar todo el grupo"}
                >
                  {g.etiqueta}
                </button>
                {g.indices.map(casillaResultado)}
              </div>
            );
          })}
          <p className="lay-nota">
            La clasificación sale del diccionario oficial de códigos de
            ElectroHuila. En la ficha de cada registro se puede ver qué regla la
            decidió.
          </p>

          <div className="lgrp">
            <h4>Cómo dibujarlos</h4>
            {casillaCapa("heat", "Mapa de calor")}
            {casillaCapa("markers", "Marcadores por municipio")}
            {casillaCapa("puntos", "Puntos sueltos")}
            {casillaCapa("gps", "Coordenada GPS real")}
            {casillaCapa("approx", "Ubicación aproximada")}
            <p className="lay-nota">
              Los <b>marcadores</b> resumen cada municipio (clic → ver solo ese
              municipio). El <b>mapa de calor</b> y los <b>puntos</b> dibujan
              registro por registro, y las dos últimas casillas deciden cuáles
              entran según lo fina que sea su coordenada.
            </p>
          </div>

          <div className="lgrp">
            <h4>Límites oficiales</h4>
            {casillaCapa("zpoly", "Zonas operativas")}
            {casillaCapa("bpoly", "Municipios")}
            {casillaCapa("mpoly", "Perímetros urbanos")}
          </div>

          <div className="lgrp">
            <h4>Ajustes del riesgo</h4>
            <div className="lay-num">
              <span>Mínimo de registros</span>
              <input
                type="number"
                min={1}
                max={5000}
                step={10}
                value={st.minOrders}
                onChange={(e) => onFilterChange("minOrders", Math.max(1, +e.target.value || 1))}
              />
            </div>
            <div className="lay-num">
              <span>Umbral de foco: {st.hotspot}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={st.hotspot}
                onChange={(e) => onFilterChange("hotspot", +e.target.value)}
              />
            </div>
            <p className="lay-nota">
              Un municipio entra al índice de riesgo si tiene al menos ese número
              de registros en el filtro actual. Los que pasan el umbral de foco
              se marcan con un aro que late.
            </p>
          </div>

          <div className="lgrp" id="legend">
            <h4>Índice de riesgo</h4>
            <div><i style={{ background: P.st[0] }} /> 0–30 &middot; Bajo</div>
            <div><i style={{ background: P.st[1] }} /> 31–60 &middot; Medio</div>
            <div><i style={{ background: P.st[2] }} /> 61–100 &middot; Alto</div>
          </div>

          {cobertura && (
            <div className="cob">
              <h4>Cobertura geográfica</h4>
              <div><b>{n0(cobertura.gps_real)}</b> con GPS real ({pct(cobertura.gps_real)})</div>
              <div>
                <b>{n0(cobertura.centroide_municipio)}</b> en el centro de su
                municipio ({pct(cobertura.centroide_municipio)})
              </div>
              <div className={cobertura.sin_ubicacion ? "cob-warn" : undefined}>
                <b>{n0(cobertura.sin_ubicacion)}</b> sin ubicación ({pct(cobertura.sin_ubicacion)})
              </div>
              {cobertura.sin_ubicacion > 0 && (
                <p className="lay-nota">
                  Sin ubicación = sin coordenada y con un municipio que no está en
                  el área de ElectroHuila (Bogotá, Ibagué, Medellín…). No se
                  dibujan y no cuentan en ninguna cifra del mapa.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
