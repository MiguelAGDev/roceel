// Iconos de trazo (24×24, currentColor). Inline para no sumar una dependencia por unos cuantos.
import type { ReactNode, SVGProps } from "react";

function make(paths: ReactNode) {
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
        {paths}
      </svg>
    );
  };
}

export const IconScan = make(<><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8v8M10 8v8M13 8v8M17 8v8" /></>);
export const IconDashboard = make(<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>);
export const IconWarehouse = make(<><path d="M3 21V8l9-5 9 5v13" /><path d="M7 21v-8h10v8M7 17h10" /></>);
export const IconOrder = make(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h4" /></>);
export const IconHistory = make(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>);
export const IconAlert = make(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>);
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />);
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />);
export const IconOut = make(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>);
export const IconTransfer = make(<><path d="M4 8h14l-4-4M20 16H6l4 4" /></>);
export const IconCount = make(<><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>);
export const IconFlash = make(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />);
export const IconZoom = make(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" /></>);
export const IconSearch = make(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);
export const IconRefresh = make(<><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" /></>);
export const IconCamera = make(<><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></>);
export const IconKeyboard = make(<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>);
export const IconLink = make(<><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>);
export const IconBack = make(<path d="M15 18 9 12l6-6" />);
export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconMinus = make(<path d="M5 12h14" />);
export const IconTrash = make(<><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" /></>);
