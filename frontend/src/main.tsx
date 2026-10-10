// Entrada: HashRouter (la app son estáticos servidos por FastAPI en /ui; el hash evita 404 al recargar),
// barra superior con navegación y estado del consumidor, y las páginas cargadas bajo demanda.
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api, consumerHealth, fmtDateTime, useApi } from "./api";
import { IconAdvisor, IconDashboard, IconOrder, IconScan, IconWarehouse } from "./components/icons";
import { Loading } from "./components/ui";
import "./styles.css";

const Piso = lazy(() => import("./pages/Piso"));
const Tablero = lazy(() => import("./pages/Tablero"));
const Almacen = lazy(() => import("./pages/Almacen"));
const Orden = lazy(() => import("./pages/Orden"));
const Kardex = lazy(() => import("./pages/Kardex"));
const Asesor = lazy(() => import("./pages/Asesor"));

/** "/" lleva al Piso en un celular y al Tablero en una computadora. */
function Home() {
  const phone = hasTouchCamera() && window.innerWidth < 768;
  return <Navigate to={phone ? "/piso" : "/tablero"} replace />;
}

function ConsumerIndicator() {
  const state = useApi((s) => api.dashboard(s).then((d) => d.consumer), [], { pollMs: 15_000 });
  const { tone, text } = consumerHealth(state.data, Boolean(state.error));
  const title = state.data
    ? `${state.data.processed} eventos procesados · último ${fmtDateTime(state.data.last_processed_at)}`
    : text;
  return (
    <Link to="/tablero?tab=consumidor" className="consumer-status" title={title} aria-label={`Estado del consumidor: ${text}`}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      <span className="consumer-text">{text}</span>
    </Link>
  );
}

const NAV = [
  { to: "/piso", label: "Piso", Icon: IconScan },
  { to: "/tablero", label: "Tablero", Icon: IconDashboard },
  { to: "/almacen", label: "Almacén", Icon: IconWarehouse },
  { to: "/ordenes", label: "Órdenes", Icon: IconOrder },
  { to: "/asesor", label: "Asesor", Icon: IconAdvisor },
];

function App() {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Almacén del taller, inicio">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">Almacén</span>
        </Link>
        <nav className="nav" aria-label="Principal">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} aria-label={label}>
              <Icon /><span className="nav-text">{label}</span>
            </NavLink>
          ))}
        </nav>
        <ConsumerIndicator />
      </header>
      <main>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/piso" element={<Piso />} />
            <Route path="/tablero" element={<Tablero />} />
            <Route path="/almacen" element={<Almacen />} />
            <Route path="/ordenes" element={<Orden />} />
            <Route path="/ordenes/:code" element={<Orden />} />
            <Route path="/kardex" element={<Kardex />} />
            <Route path="/kardex/:partId" element={<Kardex />} />
            <Route path="/asesor" element={<Asesor />} />
            <Route path="*" element={<div className="empty"><h1>Página no encontrada</h1><p><Link to="/">Ir al inicio</Link></p></div>} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </StrictMode>,
);
