# Mapa de calor — ElectroHuila

Visor de la distribución geográfica de las suspensiones de ElectroHuila. Lee el
histórico de PostgreSQL, lo cruza contra los límites oficiales del área que
atiende la empresa y lo dibuja como mapa de calor.

Es un proyecto independiente: solo el mapa. No hay asistente, ni chat, ni
tableros de análisis.

```
ElectroHuila_Mapa_Nuevo/
├── etl/                      Python · PostgreSQL + geografía -> JSON del mapa
│   ├── eh_etl/
│   │   ├── config.py         conexión, rutas, caja geográfica, consulta
│   │   ├── clasificacion.py  ⭐ las 6 reglas que deciden el resultado
│   │   ├── homologacion.py   ⭐ municipios y agrupación operativa
│   │   ├── database.py       acceso de solo lectura
│   │   ├── transformar.py    aplica la clasificación y deriva columnas
│   │   ├── geografia.py      carga de capas + índice espacial
│   │   ├── geolocalizar.py   coordenada propia, clave administrativa, motivos
│   │   ├── payload.py        dimensiones, puntos, partición por mes
│   │   └── pipeline.py       orquestación
│   ├── run_etl.py            CLI
│   └── requirements.txt
├── config/
│   ├── homologacion_codigos.json   tabla generada desde el diccionario
│   └── ciclos.json                 ficha de cada ciclo de suspensión
├── scripts/
│   ├── preparar_geografia.py    paso único: `Geografia/` -> web/public/geojson/
│   ├── preparar_homologacion.py paso único: diccionario .xlsx -> config/
│   ├── preparar_ciclos.py       paso único: Excel de ciclos -> config/
│   └── validar.py               comprobación de punta a punta
├── Diccionarios/                insumos oficiales de la clasificación
│   ├── Diccionario_codigos_electrohuila.xlsx   qué resultado asigna cada código
│   └── observaciones (2).xlsx                  qué ES cada código
├── web/                      Next.js · el visor
│   ├── src/app/              layout, página y hoja de estilo
│   ├── src/components/       MapaCalor, PanelCapas, BarraFiltros, FiltroPildora
│   ├── src/lib/              tema, caché de meses, global de Leaflet
│   └── public/               data.json, data_YYYY-MM.json y geojson/
├── .env.example
└── README.md
```

---

## 1. Puesta en marcha

```bash
# 1. Credencial
cp .env.example .env          # y completa DATABASE_URL

# 2. ETL
pip install -r etl/requirements.txt
python etl/run_etl.py         # ~30 s; escribe web/public/data*.json

# 3. Visor
npm install --prefix web
npm run dev --prefix web      # http://localhost:3000
```

Para producción:

```bash
npm run build --prefix web
npm run start --prefix web
```

La geografía y la homologación de códigos ya vienen preparadas dentro del
proyecto. Solo hay que regenerarlas si cambian los insumos:

```bash
python scripts/preparar_geografia.py      # si cambian los límites oficiales
python scripts/preparar_homologacion.py   # si ElectroHuila actualiza el diccionario
python scripts/preparar_ciclos.py         # si cambia la sectorización por ciclos
```

Comprobar que todo está en su sitio:

```bash
python scripts/validar.py
```

### Variable de entorno

Una sola, y es la única credencial del proyecto:

```
DATABASE_URL=postgresql://usuario:clave@host:5432/base
```

Se acepta también la cadena de palabras clave de libpq
(`host=… port=5432 dbname=… user=… password=…`), que es la que usa la operación
hoy: psycopg2 entiende las dos y el código no las reescribe.

Opcionales: `EH_TABLA` (por si la tabla cambia de nombre o de esquema),
`EH_OUTPUT_DIR`, `EH_GEOJSON_DIR`, `EH_GEOGRAFIA_DIR`, `EH_LOG_LEVEL`.

---

## 2. De dónde salen los datos

**Tabla:** `dbanalitica.historico_electrohuila` — 422.727 filas, de enero 2025 a
septiembre 2026.

> El encargo la nombraba `historico_electrohuila_scr`. Ese nombre no existe en la
> base: el sufijo `_scr` lo llevan las tablas hermanas (`historico_acuacar_scr`,
> `historico_afinia_scr`) pero la de ElectroHuila no. Se usa la que existe y el
> nombre queda en `EH_TABLA`, así que si mañana se renombra basta cambiar la
> variable.

Columnas que consume el mapa y en qué se convierten:

| Columna de la tabla | Dimensión del mapa | Se muestra como |
|---|---|---|
| `coordenada_x` / `coordenada_y` | latitud / longitud | el punto en el mapa |
| `nombre_muni` | unidad geográfica | Municipio |
| `estado` | clasificación | entra a las reglas del diccionario |
| `observacion_suspension` | clasificación + filtro | Observación de la visita |
| `causal_suspension` | clasificación + filtro | Causal de suspensión |
| `suspension_en` | clasificación + detalle | Suspensión en |
| `ciclo` | filtro + detalle | Ciclo de suspensión |
| `fecha_reconexion` | filtro + detalle | Actividad (suspensión / reconexión) |
| `clase_servicio` | filtro | Clase de servicio |
| `ubicacion` | detalle | Urbano / Rural |
| `estrato` | detalle | Estrato |
| `funcionario` | detalle | Funcionario |
| `numero_documento`, `cuenta` | identificadores | Documento, Cuenta |
| `fecha_accion` (o `fecha_generacion`) | eje temporal | filtro de meses |

**Un aviso sobre los nombres de columna:** `coordenada_x` guarda la LATITUD y
`coordenada_y` la LONGITUD, al revés de lo que sugiere el nombre. Se comprobó
contra los datos (x va de 0,5 a 3,9 y el Huila está entre 1,5 y 3,9 N) y contra
los polígonos del IGAC. 58 filas vienen con el par invertido y el ETL las
corrige.

### Cómo se clasifica el resultado de cada orden

La clasificación sale **exclusivamente** de las guías de `Diccionarios/`.
`scripts/preparar_homologacion.py` las convierte en
`config/homologacion_codigos.json` y `eh_etl/clasificacion.py` lo aplica. No hay
ninguna equivalencia inventada ni coincidencia aproximada de texto: lo que las
guías no cubren queda marcado como `SIN CLASIFICAR`, con el motivo.

Son dos archivos y se complementan:

* **`Diccionario_codigos_electrohuila.xlsx`** dice **qué resultado** asigna cada
  código. Es la fuente de la clasificación.
* **`observaciones (2).xlsx`** dice **qué es** cada código: a qué operación
  pertenece (suspensión o reconexión), con qué brigada se ejecuta, si se usa en
  cartera y el contexto operativo de campo. No cambia ningún resultado; aporta
  las descripciones que faltaban y dos dimensiones nuevas al mapa —
  **Operación** y **Brigada**.

El primero trae dos hojas y se usan las dos:

* **`Códigos`** — 68 códigos repartidos en cuatro columnas
  (`observacion_suspension`, `causal_suspension`, `suspension_en`, `estado`),
  cada uno con su significado oficial, el resultado que asigna y si decide por
  sí solo.
* **`Combinaciones`** — 147 ternas (causal, suspensión en, código) ya resueltas,
  con cuántas actas respaldan cada una.

#### Las seis reglas

Se aplican en orden; la primera que resuelve gana, y su nombre viaja con la
orden hasta la ficha del mapa.

| Regla | Qué mira | Cubre |
|---|---|---:|
| `R1_combinacion` | la terna exacta de la hoja «Combinaciones» | 82,4 % |
| `R2_estado` | el Estado, cuando decide solo (`A` = orden sin ejecutar) | 3,0 % |
| `R3_codigo` | el código de observación, cuando decide solo | 6,8 % |
| `R4_causal` | la causal, cuando decide sola (`FP` = factura pagada) | 0,0 % |
| `R5_suspension_en` | dónde se ejecutó, que manda si el código es ambiguo | 7,7 % |
| `R6_sin_regla` | nada decide: `SIN CLASIFICAR` + motivo | 0,02 % |

`R1` va primero porque es la resolución explícita del diccionario, y solo cede
cuando la propia hoja dice «(varía por Estado)» — que es justo lo que resuelve
`R2`. `R2` va antes que `R3` porque el diccionario marca `Estado = A` como
decisor único: si la orden no se ejecutó, da igual qué diga el código.

#### Extracto de la tabla de homologación

Los catorce códigos de observación con más actas (la tabla completa está en
`config/homologacion_codigos.json`):

| Operación | Código | Descripción oficial | Resultado |
|---|---|---|---|
| Suspensión | `UC` | USUARIO YA CANCELO | PAGÓ |
| Suspensión | `SY` | SUSPENSION REALIZADA | SUSPENDIDO |
| Suspensión | `EP` | PERSUASION ESPECIAL | — (lo deciden los otros campos) |
| Suspensión | `NI` | (no está en el catálogo) | — (lo deciden los otros campos) |
| Suspensión | `AA` | ACTA ANULADA | SIN INFORMACIÓN |
| Suspensión | `SN` | SUSPENDIDO SIN RETIRO DE MATERIAL | SUSPENDIDO |
| Suspensión | `YC` | USUARIO CON FACTURA PAGA | PAGÓ |
| Suspensión | `AV` | Elaboración de Acta de Visita | — (lo deciden los otros campos) |
| Suspensión | `SA` | SIN ACCESO | NO ES POSIBLE SUSPENDER |
| Suspensión | `MR` | SUSPENSION EN MOTO CON RETIRO | SUSPENDIDO |
| Suspensión | `SS` | SE ENCONTRO SUSPENDIDO | — (lo deciden los otros campos) |
| Suspensión | `NS` | NO DEJO SUSPENDER | — (lo deciden los otros campos) |
| Reconexión | `EE` | RECONEXION REALIZADA | SUSPENDIDO |
| Reconexión | `EN` | RECONEXION SIN INSTALACION MATERIAL | SUSPENDIDO |

#### El resultado sobre los datos reales

| Resultado | Registros | | Grupo operativo |
|---|---:|---:|---|
| SIN INFORMACIÓN | 124.242 | 29,4 % | Sin información |
| SUSPENDIDO | 122.210 | 28,9 % | Suspensión ejecutada |
| PAGÓ | 120.785 | 28,6 % | No procedía suspender |
| NO ES POSIBLE SUSPENDER | 32.442 | 7,7 % | No fue posible |
| GESTIÓN DE COBRO | 15.950 | 3,8 % | No procedía suspender |
| SE MANTIENE SUSPENDIDO | 4.373 | 1,0 % | Suspensión ejecutada |
| ACTA DE RECONEXIÓN | 2.628 | 0,6 % | No procedía suspender |
| SIN CLASIFICAR | 97 | 0,02 % | Sin información |

Los 97 sin clasificar llevan su motivo. La segunda guía resolvió uno de los dos
códigos que faltaban —`AD` = ACTUALIZAR DATOS, marcado como «no se usa en
cartera»—, así que lo único que sigue sin ficha es la **causal `SV`**
(35.333 filas). La regla general la resuelve bien, pero conviene incorporarla.

#### Lo único que decide el proyecto y no el diccionario

El diccionario dice qué pasó con cada orden, pero no con qué color se dibuja ni
qué cuenta como «efectivo». Eso sale de `GRUPO_POR_RESULTADO` en
`eh_etl/homologacion.py`, que reparte los siete resultados en cuatro grupos
operativos y declara cuáles entran a la efectividad:

```
efectividad = ejecutada / (ejecutada + no fue posible)
```

Las órdenes de «no procedía suspender» y «sin información» quedan fuera del
numerador y del denominador: meterlas diluiría la cifra con casos en los que la
cuadrilla no tenía nada que hacer. Es el único juicio propio sobre los
resultados, está en un solo lugar y se puede cambiar sin tocar nada más.

#### Trazabilidad

Cada registro del mapa guarda, además de su resultado: el código de observación,
la causal, el «suspensión en», el `estado` crudo, la regla que decidió y el
motivo por el que quedó donde quedó. La ficha que abre al hacer clic en un punto
los muestra todos bajo «Por qué quedó así».

## 3. Cómo se geolocaliza cada registro

Tres caminos, en este orden.

**1 · Coordenada propia — 151.931 registros (35,9 %).** Si `coordenada_x` /
`coordenada_y` son válidas y son **coherentes con la clave administrativa** de la
orden, se usan tal cual. El municipio se resuelve por *punto en polígono*
(`shapely.STRtree`), no por nombre.

**2 · Clave administrativa — 270.308 registros (64,0 %).** Si no hay coordenada,
o la que hay contradice la clave, se ubica por la combinación administrativa
completa, en el punto representativo del polígono oficial. No es una coordenada
inventada: es el centro del polígono del IGAC, y viaja marcada como aproximada
para que el visor pueda apagarla.

**3 · Sin ubicación — 488 registros (0,12 %).** Si ninguna de las dos resuelve
sin ambigüedad, la orden queda sin ubicar con su motivo anotado. Es preferible
dejarla sin ubicación que ponerla en el sitio equivocado.

```
422.727 filas = 151.931 coordenada propia + 270.308 clave administrativa + 488 sin ubicar
```

### La validación de coherencia

Esto es lo que más cambia el mapa: **13.214 órdenes traen una coordenada válida
que cae en un municipio distinto al que declaran**, y casi todas aterrizan en el
mismo punto de Neiva (≈ 2.9087, -75.2815), compartido por registros de 48
municipios diferentes. Esa coordenada no es la del predio: es donde se levantó
el acta. Tomarla al pie de la letra pinta un foco falso en Neiva y vacía el
resto del departamento, así que esas órdenes bajan al respaldo administrativo
con el motivo `incoherente`.

La comprobación es nivel a nivel y solo sobre los niveles que la orden declara:
un nivel vacío no puede contradecir a nadie, pero tampoco confirma nada. Si el
nombre de municipio apuntara a más de una ubicación, la orden quedaría sin
ubicar (`municipio_ambiguo`) en vez de asignarse a la primera coincidencia; hoy
los 42 nombres de la capa son únicos, así que ese caso no se da.

### Los niveles disponibles

El encargo pide validar `Departamento → Municipio → Barrio → Corregimiento →
Vereda`. De esos, `historico_electrohuila` **solo trae municipio**
(`nombre_muni`): no hay columnas de departamento, barrio, corregimiento ni
vereda. `direccion` es texto libre, y aunque se extrajera el barrio no habría
geometría de barrio contra la cual cruzarlo (ver abajo).

`ClaveAdministrativa`, en `eh_etl/geolocalizar.py`, está escrita por niveles
precisamente para eso: el día que la tabla traiga más, se agregan a `NIVELES` y
a la capa geográfica, y el cruce y la detección de ambigüedad ya funcionan por
clave completa.

### Los motivos

Cada registro lleva por qué quedó donde quedó, y el conteo viaja hasta el panel
de capas:

| Motivo | Qué significa | Registros |
|---|---|---:|
| `gps` | GPS propio de la orden, coherente con su municipio | 151.931 |
| `sin_coordenada` | la orden no trae coordenada | 257.094 |
| `incoherente` | la coordenada cae en otro municipio | 13.214 |
| `fuera_del_area` | la coordenada cae fuera del área de ElectroHuila | 2 |
| `municipio_desconocido` | el municipio no está en el área (Bogotá, Ibagué…) | 488 |
| `municipio_ambiguo` | el nombre apunta a más de una ubicación | 0 |
| `sin_clave` | la orden no trae ningún nivel administrativo | 0 |

### Actividad: suspensión o reconexión

`historico_electrohuila` es el plano de control de **suspensiones**: las 422.727
filas nacen como orden de suspensión —todas traen `causal_suspension` y
`fecha_generacion`—. La reconexión no es otro tipo de orden en esta tabla: es el
evento posterior sobre la misma orden.

La señal es inequívoca y por eso el filtro se apoya en ella:

| | Filas | Con `fecha_reconexion` |
|---|---:|---:|
| `estado = 'R'` (reconectado) | 82.879 | **82.879 (100 %)** |
| `estado = 'S'` (suspendido) | 267.546 | 68 (0,03 %) |
| `estado = 'N'` / `'A'` | 72.302 | 0 |

De ahí sale la dimensión **Actividad**, con dos valores:

- **Suspensión** — 339.681 órdenes sin reconexión registrada.
- **Reconexión** — 83.046 órdenes que sí la registraron (`fecha_reconexion`, o
  un código de observación que la guía marca como de reconexión: son solo 131
  filas, pero confirman la visita).

La ficha del registro muestra además cuánto tardó: «Reconexión (el mismo día)»,
«(al día siguiente)», «(a los 12 días)». Los pocos casos con fecha de reconexión
anterior a la de acción (92 filas) se descartan como dato inconsistente, no se
muestran como reconexión anticipada.

**No confundir con «Operación en campo»**, que es otro filtro y otra cosa: ese
sale del código de observación y dice qué hizo la cuadrilla en la visita según
la guía de observaciones. Hoy el 78 % de los registros cae en «sin definir»
porque los códigos dominantes (`NI`, `UC`, `AA`) no declaran operación, así que
para dividir el trabajo por actividad sirve **Actividad**, no aquel.

### Ver el mapa por ciclos

El panel de capas tiene un selector **«Agrupar el mapa por»** con dos opciones:

| | Unidad | Centro del marcador | Polígono |
|---|---|---|---|
| **Municipio** | 41 municipios con registros | punto representativo del polígono, o la mediana de sus GPS reales si tiene ≥ 5 | sí, coloreado por riesgo |
| **Ciclo** | 96 ciclos | mediana de los GPS reales del ciclo | no: un ciclo puede abarcar varios municipios |

Los marcadores, la efectividad y el índice de riesgo se recalculan sobre la
unidad elegida — es literalmente de qué array sale la clave de agregación, así
que las dos vistas usan el mismo motor. Al agrupar por ciclo, el polígono
municipal se sigue pudiendo dibujar, pero como límite sin color: su agregado ya
no corresponde a la unidad activa.

Seleccionar un ciclo (clic en su marcador, o la píldora «Ciclo de suspensión»)
deja en el mapa solo sus registros y vuela a su centro.

### El ciclo de suspensión

`ciclo` viene poblado al 100 % (96 valores distintos, rango 1–200) y es la única
columna de la tabla que baja del municipio: describe cómo está sectorizada la
operación. `scripts/preparar_ciclos.py` le arma una ficha desde dos Excel de
`Geografia/`:

| Insumo | Qué aporta | Cobertura |
|---|---|---|
| `Ciclos de Suspensión.xlsx` | zona operativa, **usuarios** y descripción del área | 95 ciclos · 99,89 % de las filas |
| `SECTORES-2.xlsx` | qué municipios toca cada ciclo | 72 ciclos · referencia |

Los **usuarios por ciclo** (414.502 en total) son lo más valioso: son el
denominador que convierte un conteo de órdenes en una tasa. Van en el payload
(`dim.cicloUsuarios`) y se ven en la ficha de cada registro.

Qué **no** se hace con el ciclo, y por qué:

- **No ubica.** De las 488 órdenes sin ubicación, el ciclo solo resolvería 8:
  las otras 480 son el ciclo 1, «NO REGULADOS TODO DEPARTAMENTO DEL HUILA», que
  por definición no localiza nada.
- **No reemplaza la zona.** La zona del ciclo coincide con la del municipio en
  el 95,3 % de las filas. Las diferencias son de dos tipos: los municipios
  partidos (Suaza, Tarqui, Pital), donde el ciclo acierta más, y los ciclos
  departamentales (1, 60, 80, 200), donde la zona del Excel es solo dónde se
  administra el ciclo, no dónde está el cliente. Mezclar los dos casos daría una
  zona peor que la actual.
- **No descarta órdenes.** `SECTORES-2.xlsx` está incompleto: el 87,4 % de los
  pares (ciclo, municipio) coinciden y un 1,5 % no, pero esas discrepancias se
  concentran en los ciclos rurales grandes, que en la base tocan más municipios
  de los que el Excel lista. Se guarda como **indicador de calidad** en
  `meta.ubicacion.ciclo`, nunca como criterio de rechazo.

### Por qué el municipio y no el barrio

El visor de referencia agregaba por barrio, con 1.240 polígonos catastrales. Para
ElectroHuila esa capa no existe: de los archivos de `Geografia/`, el de manzanas
cubre 35 municipios y el de perímetros urbanos 34, **y ninguno de los dos incluye
a Neiva**, que es el 49 % de los registros. Agregar por una unidad que deja fuera
a la mitad de los datos habría sido peor que no tenerla.

Así que la unidad es el municipio (42 polígonos, cobertura completa) y el detalle
fino lo pone el mapa de calor, que dibuja registro por registro sobre los GPS
reales. Los perímetros urbanos quedan como capa de referencia, activable desde el
panel.

### Archivos de `Geografia/` utilizados

| Archivo | Para qué |
|---|---|
| `raw/municipios_electrohuila.geojson` | los 42 municipios del área (37 del Huila + Alpujarra, Ataco y Planadas en Tolima, Páez en Cauca y San Vicente del Caguán en Caquetá). Unidad de agregación y punto en polígono. |
| `Municipios.xlsx` | municipio → zona operativa (Norte, Sur, Centro, Occidente). |
| `raw/huila_perimetro_raw.geojson` | 85 perímetros urbanos y centros poblados. Capa de referencia. |
| `geo_zonas_ajuste.py` | no se ejecuta: se reimplementaron sus reglas (ver abajo). |

Los que **no** se usan y por qué: `huila_manzana_raw.geojson` (7.800 manzanas sin
nombre y sin Neiva), `huila_municipios_raw.geojson` y
`extra_municipios_raw.geojson` (ya fusionados en `municipios_electrohuila`),
`huila_departamento_raw.geojson` (solo servía para recortar), `SECTORES-2.xlsx` y
`Ciclos de Suspensión.xlsx` (relacionan ciclo y sector con barrios, pero
`codigo_ruta` de la tabla no se decodifica de forma fiable: tiene longitudes
mezcladas de 10 y 11 dígitos y el cruce no es estable).

Las cuatro zonas se construyen disolviendo municipios, con los ajustes que
`geo_zonas_ajuste.py` dejó documentados y que `scripts/preparar_geografia.py`
reimplementa con shapely (para no arrastrar geopandas):

- Guadalupe, Altamira y Gigante → Centro (no están en el Excel).
- Suaza y Tarqui se parten por la mitad norte/sur → Sur y Centro.
- Pital se parte oriente/occidente → Occidente y Centro.

Un municipio partido aparece en las dos zonas en la capa `zonas.geojson`; como
unidad se le atribuye la zona de su mitad más grande.

---

## 4. Qué hace el mapa

Lo mismo que el visor de referencia, con la fuente cambiada.

- **Basemap vectorial** de OpenFreeMap (teselas de OpenStreetMap, sin API key)
  servido por maplibre-gl dentro de Leaflet, recoloreado según el tema.
- **Mapa de calor** con una rampa por **grupo operativo**, superpuestas: se lee
  *qué* se concentra, no solo *cuánto*. El filtro es por resultado (los siete
  del diccionario) pero el color va por grupo, para no superponer siete rampas.
  La suspensión ejecutada pesa menos (0,6) porque es el grupo más numeroso y si
  no tapa a las que no se pudieron ejecutar. Tiene **leyenda propia** en el
  panel, con la rampa de cada grupo.
- **Marcadores por municipio**: tamaño por volumen —relativo al municipio más
  cargado del filtro—, color por índice de riesgo, y un aro que late en los que
  pasan el umbral de foco.
- **Puntos sueltos** sobre un canvas propio, no como capas de Leaflet: 400.000
  `circleMarker` matan el navegador; un canvas que se repinta en `moveend`
  aguanta el histórico completo con tope de 8.000 puntos por cuadro. Se puede
  hacer clic en un punto para ver la ficha del registro.
- **Capas de límites**: zonas operativas, municipios (coloreados por riesgo) y
  perímetros urbanos.
- **Filtro por resultado** en el panel de capas, agrupado por grupo operativo:
  cada encabezado marca o desmarca su grupo completo.
- **Ficha de registro con trazabilidad**: al hacer clic en un punto se ve el
  resultado y, debajo, los cuatro códigos originales con su significado
  oficial, la regla que decidió y el motivo de la ubicación.
- **Filtros en cascada** (zona, municipio, causal, actividad, operación en
  campo, ciclo, clase de servicio, meses):
  cada desplegable solo ofrece lo que el resto de filtros deja con datos.
- **Selección de meses** multi-selección con descarga perezosa: al abrir solo
  llega el mes en curso; los demás se piden al marcarlos y se guardan en
  IndexedDB con caducidad de una hora.
- **Índice de riesgo 0–100** por municipio, sobre las órdenes que había que
  ejecutar: 65 % la proporción que no se pudo ejecutar, 15 % volumen, 10 %
  tendencia, 10 % historial de los funcionarios que lo atienden. Las
  referencias son el percentil 90 del propio período, no umbrales fijos.
- **Tema claro / oscuro**, zoom, encuadre automático al área y leyenda.

### Cómo está calibrado el calor

Tres decisiones que vale la pena conocer, porque determinan qué significa un
color:

1. **La intensidad es relativa a lo que se está viendo.** El punto de saturación
   de cada rampa es el percentil 98 de la densidad de los registros dibujados,
   no un tope fijo. Un tope fijo saturaba siempre en Neiva y nunca en el resto.
2. **La celda de referencia mide lo que el radio del calor ocupa en el
   terreno**, y por eso se recalcula en cada `zoomend`: al acercarse, la misma
   mancha cubre menos terreno, hay menos registros por celda y el umbral baja
   con ella. Sin esto, el calor se leía bien a un solo nivel de zoom.
3. **`maxZoom` se fija al zoom actual.** En `leaflet.heat` esa opción no es el
   zoom máximo: es el zoom a partir del cual cada punto pesa 1, y por debajo el
   peso se divide entre `2^(maxZoom − zoom)`. Con el valor fijo que traía el
   visor de referencia (13), a escala departamental cada punto pesaba 1/32 y el
   calor salía casi invisible.

Como el umbral se calcula sobre los puntos dibujados, **cruzar más meses no
calienta el mapa**: suben a la vez los conteos y el umbral, así que los colores
siguen siendo comparables. Lo que no es comparable es un mapa contra otro: la
escala es relativa a cada vista, y la leyenda lo dice.

Al agrupar por ciclo, el tooltip del marcador añade la **tasa por cada 1.000
usuarios** del ciclo, con el total de usuarios entre paréntesis. Es la única
forma de comparar un ciclo residencial con uno corporativo: el ciclo 80 tiene
716 usuarios y más de 15.000 órdenes.

### Rendimiento

Los registros viven en `TypedArray`s y el filtro produce un `Int32Array` de
índices; la agregación es un solo recorrido. Medido con el histórico completo
(422.474 registros, 21 meses) en este equipo: `data.json` se descarga en ~95 ms y
el visor responde a un cambio de filtro sin bloquearse. El mes en curso pesa
1,7 MB y cada mes histórico entre 1,0 y 1,6 MB.

### Diferencias deliberadas con el visor de referencia

1. **La ubicación aproximada viene apagada.** El 61 % de los registros se ubica
   en el centroide de su municipio; un mapa de calor que los incluyera sin avisar
   dibujaría 42 manchas donde no hay nada. Las casillas «Coordenada GPS real» y
   «Ubicación aproximada» gobiernan tanto el calor como los puntos.
2. **Lo aproximado lo decide el ETL**, no el navegador. El visor original lo
   adivinaba marcando como aproximados los GPS que se repetían cinco veces o más;
   aquí el origen de cada coordenada se conoce y viaja en el payload.
3. **La coordenada incoherente no se usa.** El visor original confiaba en todo
   GPS dentro de la caja; aquí se exige además que coincida con el municipio
   declarado, lo que descarta 13.214 puntos que se apilaban sobre la sede.
4. **Los estados no son tres.** El original tenía Efectiva / Fallida / Perdida
   fijos. Aquí la dimensión la define el diccionario (siete resultados), y los
   tres colores del mapa corresponden a grupos operativos, no a estados.
5. **La efectividad excluye lo que no había que ejecutar.** Las órdenes de
   «no procedía suspender» y «sin información» no entran al numerador ni al
   denominador.

---

## 5. Notas de operación

**Compilación.** Los scripts usan `--webpack`. En este equipo una directiva de
Control de aplicaciones de Windows bloquea el binario nativo de SWC y Turbopack
no arranca sin él. Donde no haya ese bloqueo, `npm run build:turbo --prefix web`
y `npm run dev:turbo --prefix web` usan Turbopack y son bastante más rápidos.

**Worker de maplibre.** maplibre-gl resuelve la URL de su worker desde
`import.meta.url`, que con el bundler de Next no es http(s), así que se rinde y
el basemap se queda en negro. `web/scripts/copiar-worker-maplibre.mjs` (que corre
en el `postinstall`) copia el worker y su chunk compartido a
`web/public/maplibre/`, y el mapa lo apunta con `setWorkerUrl`.

**Avisos de consola que no son errores.** El visor no produce errores. Quedan dos
avisos de terceros: `Canvas2D: willReadFrequently` (de `leaflet.heat`, que lee el
canvas para colorear el degradado) e `Image "circle-11" could not be loaded` (un
icono que falta en el estilo de OpenFreeMap).

**Actualizar los datos.** Se vuelve a correr `python etl/run_etl.py`. El botón
de refresco del visor limpia la caché local y vuelve a pedir el mes en curso. El
payload generado está en `.gitignore`: son datos, no código.

---

## 6. Proyecto de referencia

El mapa se reconstruyó a partir del visor **Centro Operativo SCR — Air-E
Atlántico** (`Frontend/dashboard`, Next.js 16 + Leaflet + maplibre-gl +
leaflet.heat) y de su ETL (`etl/`, que alimentaba `dbanalitica.historico_mo`).
De ahí vienen el formato del payload, el motor de filtrado sobre `TypedArray`s,
el índice de riesgo, el canvas de puntos, la paleta y la hoja de estilo. Se dejó
fuera todo lo que no era el mapa: asistente, panel de detalle, ranking, dock de
tendencias y carga de órdenes.
