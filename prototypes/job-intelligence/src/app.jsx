import {
  Briefcase,
  BookmarkSimple,
  Database,
  MagnifyingGlass,
  X,
  CaretDown,
  CaretRight,
  CaretLeft,
  ArrowUp,
  ArrowDown,
  SlidersHorizontal,
  Funnel,
  Check,
  MapPin,
} from "@phosphor-icons/react";
import { Fragment, useEffect, useState } from "react";

const definitions = {
  client: "Opdrachtgever",
  contract: "Contract",
  deadline: "Deadline",
  hours: "Uren",
  location: "Locatie",
  rate: "Tarief",
  source: "Bron",
  start: "Startdatum",
  title: "Functie",
};
const defaults = ["title", "location", "rate", "hours", "deadline"];
const titles = [
  "Senior Data Engineer",
  "Cloud Data Engineer",
  "Analytics Engineer",
  "Data Platform Engineer",
  "BI Engineer",
  "Data Engineer Azure",
  "Business Analist",
  "Product Owner",
  "Java Developer",
  "Projectleider IT",
  "Data Architect",
  "Platform Engineer",
];
const clients = [
  "Voorbeeldorganisatie Noord",
  "Voorbeeldorganisatie West",
  "Demo Datapartners",
  "Voorbeeldbank",
  "Demo Stad & Gemeente",
  "Voorbeeldorganisatie Oost",
];
const jobs = Array.from({ length: 36 }, (_, i) => ({
  client: clients[i % 6],
  contract: ["Interim", "Interim", "Detachering", "Vast"][i % 4],
  deadline: `2026-${i % 5 === 3 ? "10" : "09"}-${String(25 + (i % 5)).padStart(2, "0")}`,
  hours: i % 3 === 2 ? "24 – 32" : "32 – 40",
  id: i + 1,
  location: [
    "Utrecht",
    "Utrecht",
    "Amersfoort",
    "Utrecht",
    "Utrecht",
    "Amsterdam",
  ][i % 6],
  rate: i % 7 === 6 ? null : 90 + (i % 5) * 5,
  source: `Voorbeeldfeed ${["A", "B", "C"][i % 3]}`,
  start: i % 4 === 3 ? null : "2026-10-01",
  title: titles[i % 12],
}));
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("nl-NL", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(value))
    : "Onbekend";
const formatField = (job, key) => {
  if (key === "rate") {
    return job.rate === null
      ? "Onbekend"
      : `€ ${job.rate} – ${job.rate + 20}/u`;
  }
  if (key === "deadline" || key === "start") {
    return date(job[key]);
  }
  return job[key];
};
const sortJobs = (a, b, sort) => {
  if (sort === "title") {
    return a.title.localeCompare(b.title);
  }
  if (sort === "rate") {
    return (b.rate ?? -1) - (a.rate ?? -1);
  }
  if (sort === "deadline") {
    return a.deadline.localeCompare(b.deadline);
  }
  return a.id - b.id;
};
const descriptionForView = (view) => {
  if (view === "Bewaard") {
    return "Je bewaarde opdrachten in deze demosessie.";
  }
  if (view === "Bronnen") {
    return "De fictieve bronnen achter deze demonstratie.";
  }
  return "Vind en analyseer relevante opdrachten van meerdere bronnen.";
};
const toggleValues = (values, setValue, value) =>
  setValue(
    values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value]
  );
const matchesFilters = (
  job,
  { contracts, hours, max, min, query, region, saved, sources, view }
) =>
  (view !== "Bewaard" || saved.includes(job.id)) &&
  query
    .toLowerCase()
    .split(/\s+/u)
    .every((term) =>
      `${job.title} ${job.client}`.toLowerCase().includes(term)
    ) &&
  (!region || job.location === region) &&
  (!contracts.length || contracts.includes(job.contract)) &&
  (!sources.length || sources.includes(job.source)) &&
  (!hours.length || hours.includes(job.hours)) &&
  (!min || (job.rate !== null && job.rate >= Number(min))) &&
  (!max || (job.rate !== null && job.rate <= Number(max)));
const checkGroup = (label, items, values, allJobs, onToggle) => (
  <fieldset>
    <legend>{label}</legend>
    {items.map((item) => (
      <label className="checkline" key={item}>
        <input
          type="checkbox"
          checked={values.includes(item)}
          onChange={() => onToggle(item)}
        />
        <span>{item}</span>
        <small>
          {allJobs.filter((job) => Object.values(job).includes(item)).length}
        </small>
      </label>
    ))}
  </fieldset>
);
const closeMenuOnEscape = (event, setMenu) => {
  if (event.key === "Escape") {
    setMenu(false);
    event.currentTarget.parentElement.querySelector("button").focus();
  }
};
const ActiveFilters = ({
  contracts,
  filterChange,
  hours,
  max,
  min,
  region,
  setContracts,
  setHours,
  setMax,
  setMin,
  setRegion,
  setSources,
  sources,
}) => (
  <div className="active-filters">
    <small>Actieve filters</small>
    <div className="chips">
      {!region &&
        !contracts.length &&
        !sources.length &&
        !hours.length &&
        !min &&
        !max && <span className="muted">Geen filters ingesteld</span>}
      {region && (
        <button onClick={() => filterChange(() => setRegion(""))}>
          {region}
          <X />
        </button>
      )}
      {contracts.map((contract) => (
        <button
          key={contract}
          onClick={() =>
            filterChange(() => toggleValues(contracts, setContracts, contract))
          }
        >
          {contract}
          <X />
        </button>
      ))}
      {[...sources, ...hours].map((value) => (
        <button
          key={value}
          onClick={() =>
            filterChange(() =>
              sources.includes(value)
                ? toggleValues(sources, setSources, value)
                : toggleValues(hours, setHours, value)
            )
          }
        >
          {value}
          <X />
        </button>
      ))}
      {(min || max) && (
        <button
          onClick={() =>
            filterChange(() => {
              setMin("");
              setMax("");
            })
          }
        >
          Tarief
          <X />
        </button>
      )}
    </div>
  </div>
);
const readColumns = () => {
  try {
    const v = JSON.parse(localStorage.getItem("ji-prototype-columns"));
    if (
      v &&
      Array.isArray(v.order) &&
      v.order.length === Object.keys(definitions).length &&
      new Set(v.order).size === v.order.length &&
      v.order.every((k) => k in definitions) &&
      Array.isArray(v.visible) &&
      v.visible.includes("title") &&
      v.visible.every((k) => k in definitions)
    ) {
      return v;
    }
  } catch {
    // Browsers may reject localStorage access in private or restricted modes.
  }
  return { order: Object.keys(definitions), visible: defaults };
};
export const App = () => {
  const [columns, setColumns] = useState(readColumns),
    [menu, setMenu] = useState(false),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState(""),
    [region, setRegion] = useState(""),
    [contracts, setContracts] = useState([]),
    [sources, setSources] = useState([]),
    [hours, setHours] = useState([]),
    [min, setMin] = useState(""),
    [max, setMax] = useState(""),
    [sourceQuery, setSourceQuery] = useState(""),
    [sort, setSort] = useState("newest"),
    [page, setPage] = useState(1),
    [expanded, setExpanded] = useState([1]),
    [selected, setSelected] = useState([]),
    [saved, setSaved] = useState([]),
    [view, setView] = useState("Opdrachten"),
    [mobileFilters, setMobileFilters] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem("ji-prototype-columns", JSON.stringify(columns));
    } catch {
      setNotice(
        "Kolomvoorkeuren kunnen in deze browser niet worden opgeslagen."
      );
    }
  }, [columns]);
  const filterChange = (fn) => {
    fn();
    setPage(1);
    setSelected([]);
  };
  const reset = () => {
    setQuery("");
    setDraft("");
    setRegion("");
    setContracts([]);
    setSources([]);
    setHours([]);
    setMin("");
    setMax("");
    setPage(1);
    setSelected([]);
  };
  const filtered = jobs.filter((job) =>
    matchesFilters(job, {
      contracts,
      hours,
      max,
      min,
      query,
      region,
      saved,
      sources,
      view,
    })
  );
  filtered.sort((a, b) => sortJobs(a, b, sort));
  const keys = columns.order.filter((k) => columns.visible.includes(k));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 5));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * 5, currentPage * 5);
  const move = (key, delta) => {
    const i = columns.order.indexOf(key);
    const order = [...columns.order];
    [order[i], order[i + delta]] = [order[i + delta], order[i]];
    setColumns({ ...columns, order });
  };
  return (
    <div className="app">
      <header>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("Opdrachten");
            reset();
          }}
        >
          CATAPULZE
        </a>
        <strong className="product">Job Intelligence</strong>
        <nav aria-label="Hoofdnavigatie">
          {[
            ["Opdrachten", Briefcase],
            ["Bewaard", BookmarkSimple],
            ["Bronnen", Database],
          ].map(([name, Icon]) => (
            <button
              key={name}
              className={view === name ? "active" : ""}
              onClick={() => {
                setView(name);
                setPage(1);
                setSelected([]);
              }}
            >
              <Icon size={20} />
              {name}
              {name === "Bewaard" && saved.length > 0 && (
                <span className="badge">{saved.length}</span>
              )}
            </button>
          ))}
        </nav>
        <span className="demo">Concept · fictieve demodata</span>
        <span className="avatar" aria-label="Demoaccount">
          DEMO
        </span>
      </header>
      <aside
        className={mobileFilters ? "filters mobile-open" : "filters"}
        aria-label="Filters"
      >
        <div className="filter-heading">
          <h2>Filters</h2>
          <button className="text-button" onClick={reset}>
            Wissen
          </button>
          <button
            className="mobile-only icon-button"
            aria-label="Filters sluiten"
            onClick={() => setMobileFilters(false)}
          >
            <X />
          </button>
        </div>
        <ActiveFilters
          contracts={contracts}
          filterChange={filterChange}
          hours={hours}
          max={max}
          min={min}
          region={region}
          setContracts={setContracts}
          setHours={setHours}
          setMax={setMax}
          setMin={setMin}
          setRegion={setRegion}
          setSources={setSources}
          sources={sources}
        />
        <label className="field-label" htmlFor="region">
          Regio
        </label>
        <div className="region">
          <MapPin size={19} />
          <select
            id="region"
            value={region}
            onChange={(e) => filterChange(() => setRegion(e.target.value))}
          >
            <option value="">Alle regio’s</option>
            {["Utrecht", "Amersfoort", "Amsterdam"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <p className="hint">Filter op de plaats van de opdracht.</p>
        {checkGroup(
          "Contract",
          ["Interim", "Detachering", "Vast"],
          contracts,
          jobs,
          (item) =>
            filterChange(() => toggleValues(contracts, setContracts, item))
        )}
        <fieldset>
          <legend>
            Tarief <span className="muted">(euro per uur)</span>
          </legend>
          <div className="rates">
            <label>
              Vanaf
              <input
                aria-label="Minimumtarief"
                type="number"
                min="0"
                value={min}
                placeholder="€ 0"
                onChange={(e) => filterChange(() => setMin(e.target.value))}
              />
            </label>
            <label>
              Tot
              <input
                aria-label="Maximumtarief"
                type="number"
                min="0"
                value={max}
                placeholder="Geen max."
                onChange={(e) => filterChange(() => setMax(e.target.value))}
              />
            </label>
          </div>
          <p className="hint">
            Onbekend tarief? Zichtbaar zonder tarieffilter.
          </p>
        </fieldset>
        {checkGroup(
          "Uren per week",
          ["24 – 32", "32 – 40"],
          hours,
          jobs,
          (item) => filterChange(() => toggleValues(hours, setHours, item))
        )}
        {checkGroup(
          "Bron",
          ["Voorbeeldfeed A", "Voorbeeldfeed B", "Voorbeeldfeed C"].filter(
            (s) => s.toLowerCase().includes(sourceQuery.toLowerCase())
          ),
          sources,
          jobs,
          (item) => filterChange(() => toggleValues(sources, setSources, item))
        )}
        <input
          className="source-search"
          aria-label="Zoek bron"
          placeholder="Zoek bron…"
          value={sourceQuery}
          onChange={(e) => setSourceQuery(e.target.value)}
        />
      </aside>
      <main>
        <div className="page-title">
          <div>
            <h1>{view}</h1>
            <p>{descriptionForView(view)}</p>
          </div>
          <button
            className="mobile-only"
            onClick={() => setMobileFilters(true)}
          >
            <Funnel />
            Filters
          </button>
        </div>
        {view === "Bronnen" ? (
          <div className="source-cards">
            {["A", "B", "C"].map((s) => (
              <article key={s}>
                <Database size={28} />
                <h2>Voorbeeldfeed {s}</h2>
                <p>12 fictieve opdrachten · geen live verbinding</p>
                <button
                  onClick={() => {
                    setView("Opdrachten");
                    reset();
                    setSources([`Voorbeeldfeed ${s}`]);
                  }}
                >
                  Bekijk opdrachten
                  <CaretRight />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <>
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                filterChange(() => setQuery(draft));
              }}
            >
              <div className="search-input">
                <MagnifyingGlass size={21} />
                <input
                  aria-label="Zoek opdrachten"
                  placeholder="Zoek op functie of opdrachtgever…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                {draft && (
                  <button
                    type="button"
                    aria-label="Zoekopdracht wissen"
                    onClick={() =>
                      filterChange(() => {
                        setDraft("");
                        setQuery("");
                      })
                    }
                  >
                    <X size={19} />
                  </button>
                )}
              </div>
              <button className="primary" type="submit">
                Zoeken
              </button>
            </form>
            <div className="toolbar">
              <span role="status">
                <strong>{filtered.length}</strong> opdrachten
              </span>
              <div className="table-tools">
                <label>
                  Sorteren{" "}
                  <select
                    aria-label="Sorteren"
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="newest">Nieuwste</option>
                    <option value="deadline">Deadline</option>
                    <option value="rate">Hoogste tarief</option>
                    <option value="title">Functie A–Z</option>
                  </select>
                </label>
                <div className="column-control">
                  <button
                    aria-expanded={menu}
                    aria-controls="columns"
                    onClick={() => setMenu(!menu)}
                  >
                    <SlidersHorizontal size={18} />
                    Kolommen
                  </button>
                  {menu && (
                    <section
                      id="columns"
                      className="column-menu"
                      aria-label="Kolomvoorkeuren"
                      onKeyDown={(e) => closeMenuOnEscape(e, setMenu)}
                    >
                      <div className="menu-heading">
                        <strong>Kolommen</strong>
                        <button
                          aria-label="Kolommen sluiten"
                          className="icon-button"
                          onClick={() => setMenu(false)}
                        >
                          <X />
                        </button>
                      </div>
                      <p className="hint">Zichtbaarheid en volgorde</p>
                      {columns.order.map((key, i) => (
                        <div className="column-option" key={key}>
                          <label>
                            <input
                              type="checkbox"
                              checked={columns.visible.includes(key)}
                              disabled={key === "title"}
                              onChange={() =>
                                setColumns({
                                  ...columns,
                                  visible: columns.visible.includes(key)
                                    ? columns.visible.filter((k) => k !== key)
                                    : [...columns.visible, key],
                                })
                              }
                            />
                            {definitions[key]}
                          </label>
                          <button
                            className="icon-button"
                            disabled={i === 0}
                            aria-label={`${definitions[key]} omhoog`}
                            onClick={() => move(key, -1)}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            className="icon-button"
                            disabled={i === columns.order.length - 1}
                            aria-label={`${definitions[key]} omlaag`}
                            onClick={() => move(key, 1)}
                          >
                            <ArrowDown size={14} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="restore text-button"
                        onClick={() =>
                          setColumns({
                            order: Object.keys(definitions),
                            visible: defaults,
                          })
                        }
                      >
                        Kolommen herstellen
                      </button>
                    </section>
                  )}
                </div>
              </div>
            </div>
            {selected.length > 0 && (
              <div className="selection">
                <span>{selected.length} geselecteerd</span>
                <button
                  onClick={() => {
                    setSaved([...new Set([...saved, ...selected])]);
                    setSelected([]);
                    setNotice(
                      "Selectie bewaard. Bekijk je opdrachten onder Bewaard."
                    );
                  }}
                >
                  <BookmarkSimple />
                  Bewaar selectie
                </button>
                <button className="text-button" onClick={() => setSelected([])}>
                  Selectie wissen
                </button>
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th aria-label="Details" />
                    <th>
                      <input
                        aria-label="Selecteer deze pagina"
                        type="checkbox"
                        checked={
                          visible.length > 0 &&
                          visible.every((j) => selected.includes(j.id))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [
                                  ...new Set([
                                    ...selected,
                                    ...visible.map((j) => j.id),
                                  ]),
                                ]
                              : selected.filter(
                                  (id) => !visible.some((j) => j.id === id)
                                )
                          )
                        }
                      />
                    </th>
                    {keys.map((k) => (
                      <th key={k}>
                        {definitions[k]}
                        {k === "title" && !keys.includes("client")
                          ? " / Opdrachtgever"
                          : ""}
                      </th>
                    ))}
                    <th aria-label="Bewaren" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((j) => (
                    <Fragment key={j.id}>
                      <tr className={expanded.includes(j.id) ? "opened" : ""}>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`${j.title} details`}
                            aria-expanded={expanded.includes(j.id)}
                            aria-controls={`detail-${j.id}`}
                            onClick={() =>
                              toggleValues(expanded, setExpanded, j.id)
                            }
                          >
                            {expanded.includes(j.id) ? (
                              <CaretDown />
                            ) : (
                              <CaretRight />
                            )}
                          </button>
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Selecteer ${j.title} ${j.id}`}
                            checked={selected.includes(j.id)}
                            onChange={() =>
                              toggleValues(selected, setSelected, j.id)
                            }
                          />
                        </td>
                        {keys.map((k) => (
                          <td
                            key={k}
                            className={k === "title" ? "job-title" : ""}
                          >
                            {k === "title" ? (
                              <>
                                <button
                                  className="title-button"
                                  onClick={() =>
                                    toggleValues(expanded, setExpanded, j.id)
                                  }
                                >
                                  {j.title}
                                </button>
                                {!keys.includes("client") && (
                                  <span>{j.client}</span>
                                )}
                              </>
                            ) : (
                              formatField(j, k)
                            )}
                          </td>
                        ))}
                        <td>
                          <button
                            className={`icon-button ${saved.includes(j.id) ? "saved" : ""}`}
                            aria-label={`${saved.includes(j.id) ? "Verwijder bewaarde" : "Bewaar"} ${j.title} ${j.id}`}
                            aria-pressed={saved.includes(j.id)}
                            onClick={() => toggleValues(saved, setSaved, j.id)}
                          >
                            <BookmarkSimple
                              weight={saved.includes(j.id) ? "fill" : "regular"}
                              size={21}
                            />
                          </button>
                        </td>
                      </tr>
                      {expanded.includes(j.id) && (
                        <tr className="detail-row" id={`detail-${j.id}`}>
                          <td colSpan={keys.length + 3}>
                            <div className="detail-grid">
                              <section>
                                <h3>De opdracht</h3>
                                <p>
                                  {j.client} zoekt in deze fictieve opdracht een{" "}
                                  {j.title.toLowerCase()} die het dataplatform
                                  verder helpt ontwikkelen. Je werkt in een
                                  multidisciplinair team aan betrouwbare
                                  oplossingen en betere datakwaliteit. Er is
                                  ruimte voor eigen initiatief en kennisdeling.
                                </p>
                                <div className="tags">
                                  <span>Data Engineering</span>
                                  <span>Azure</span>
                                  <span>Python</span>
                                  <span>ETL</span>
                                </div>
                              </section>
                              <section>
                                <h3>Praktisch</h3>
                                <dl>
                                  {[
                                    ["Startdatum", date(j.start)],
                                    ["Looptijd", "Onbekend"],
                                    ["Werklocatie", j.location],
                                    ["Bron", j.source],
                                  ].map(([k, v]) => (
                                    <div key={k}>
                                      <dt>{k}</dt>
                                      <dd>{v}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </section>
                            </div>
                            <div className="detail-footer">
                              <span>
                                Fictieve opdracht · geen externe bronpagina
                              </span>
                              <button
                                className="text-button"
                                onClick={() =>
                                  toggleValues(saved, setSaved, j.id)
                                }
                              >
                                <BookmarkSimple />
                                {saved.includes(j.id)
                                  ? "Bewaard"
                                  : "Bewaar opdracht"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {!visible.length && (
                    <tr>
                      <td colSpan={keys.length + 3}>
                        <div className="empty">
                          <MagnifyingGlass size={32} />
                          <h2>Geen opdrachten gevonden</h2>
                          <p>
                            {view === "Bewaard" && !saved.length
                              ? "Bewaar een opdracht met het bladwijzericoon."
                              : "Pas je zoekopdracht aan of wis de filters."}
                          </p>
                          <button
                            onClick={() => {
                              reset();
                              if (view === "Bewaard" && !saved.length) {
                                setView("Opdrachten");
                              }
                            }}
                          >
                            Bekijk opdrachten
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <footer className="pagination">
              <span>
                {filtered.length
                  ? `${(currentPage - 1) * 5 + 1} – ${Math.min(currentPage * 5, filtered.length)}`
                  : "0"}{" "}
                van {filtered.length} opdrachten
              </span>
              <nav aria-label="Paginering">
                <button
                  aria-label="Vorige pagina"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <CaretLeft />
                </button>
                {Array.from({ length: pageCount }, (_, i) => (
                  <button
                    aria-label={`Pagina ${i + 1}`}
                    aria-current={currentPage === i + 1 ? "page" : undefined}
                    className={currentPage === i + 1 ? "primary" : ""}
                    key={i}
                    onClick={() => setPage(i + 1)}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  aria-label="Volgende pagina"
                  disabled={currentPage === pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <CaretRight />
                </button>
              </nav>
            </footer>
          </>
        )}
        {notice && (
          <div className="notice" role="status">
            <Check />
            {notice}
            <button aria-label="Melding sluiten" onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        )}
      </main>
    </div>
  );
};
