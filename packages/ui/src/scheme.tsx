import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Scheme = "default" | "zed";

export const SCHEMES: { id: Scheme; label: string; description: string }[] = [
  { id: "default", label: "Default", description: "AntiClodeX dark slate." },
  { id: "zed", label: "Zed", description: "Lifted from the Zed editor screenshot." },
];

interface SchemeContextValue {
  scheme: Scheme;
  setScheme: (s: Scheme) => void;
}

const SchemeContext = createContext<SchemeContextValue>({
  scheme: "default",
  setScheme: () => {},
});

export function useScheme() {
  return useContext(SchemeContext);
}

export function SchemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<Scheme>(() => {
    if (typeof window === "undefined") return "default";
    const stored = localStorage.getItem("acx-scheme");
    return stored === "zed" || stored === "default" ? stored : "default";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-scheme", scheme);
    localStorage.setItem("acx-scheme", scheme);
  }, [scheme]);

  return (
    <SchemeContext.Provider value={{ scheme, setScheme }}>
      {children}
    </SchemeContext.Provider>
  );
}
