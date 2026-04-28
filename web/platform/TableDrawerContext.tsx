// =============================================================================
// TableDrawerContext — lets the platform's top-nav "table menu" button
// open a drawer whose contents are provided by whatever screen is
// currently mounted. TableScreen sets the contents while it's mounted;
// the Shell renders the open/closed drawer and the toggle button.
// =============================================================================
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface DrawerCtxValue {
  /** Drawer body (sidebar). null when no screen has registered any. */
  readonly content: ReactNode | null;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Screens call this on mount to set the drawer contents (and on
   *  unmount with null to clear). */
  setContent(content: ReactNode | null): void;
}

const Ctx = createContext<DrawerCtxValue | null>(null);

export function TableDrawerProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode | null>(null);
  const [isOpen, setOpen] = useState(false);

  const value = useMemo<DrawerCtxValue>(
    () => ({
      content,
      isOpen,
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
      setContent,
    }),
    [content, isOpen],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTableDrawer(): DrawerCtxValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTableDrawer outside <TableDrawerProvider>");
  return v;
}

/** Convenience hook for screens that want to provide drawer contents
 *  while mounted. Pass null to unregister. */
export function useProvideDrawerContent(content: ReactNode | null): void {
  const drawer = useTableDrawer();
  useEffect(() => {
    drawer.setContent(content);
    return () => drawer.setContent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);
}
