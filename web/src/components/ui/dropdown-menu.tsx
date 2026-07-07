"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cn } from "@/lib/utils";

/**
 * Work around radix-ui/primitives#2238.
 *
 * When a DropdownMenu closes, Radix restores focus to the trigger from a
 * deferred `setTimeout` (see `FocusScope`'s unmount handler). That
 * programmatic focus matches `:focus-visible` even when the menu was closed
 * with the mouse, so the trigger lights up — identical to Tab focus.
 *
 * We keep Radix's focus restoration (it's correct for a11y) but, when the
 * close was triggered by a pointer, mark the trigger with
 * `data-focus-visible-suppressed` *before* Radix calls `focus(trigger)` so the
 * Button can suppress its `:focus-visible` ring for that one focus. Keyboard
 * closes (Esc / Enter / Tab) are left untouched, so the ring still shows then.
 *
 * The close modality is read from document-level `pointerdown`/`keydown`
 * capture listeners that are only attached while the menu is open, so the
 * closing interaction is always recorded before Radix's deferred restore runs.
 */

type CloseModality = "pointer" | "keyboard";

const SUPPRESSION_ATTR = "data-focus-visible-suppressed";

const DropdownMenuFocusContext = React.createContext<{
  triggerRef: React.RefObject<HTMLButtonElement | null>;
} | null>(null);

function useDropdownMenuFocusContext() {
  return React.useContext(DropdownMenuFocusContext);
}

function composeEventHandlers<T extends { defaultPrevented: boolean }>(
  theirs: ((event: T) => void) | undefined,
  ours: (event: T) => void,
) {
  return (event: T) => {
    theirs?.(event);
    if (!event.defaultPrevented) ours(event);
  };
}

export function DropdownMenu({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const ctx = React.useMemo(() => ({ triggerRef }), []);
  return (
    <DropdownMenuFocusContext.Provider value={ctx}>
      <DropdownMenuPrimitive.Root {...props}>{children}</DropdownMenuPrimitive.Root>
    </DropdownMenuFocusContext.Provider>
  );
}

const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export function DropdownMenuTrigger({
  ref,
  onBlur,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger> & {
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const ctx = useDropdownMenuFocusContext();
  return (
    <DropdownMenuPrimitive.Trigger
      ref={ctx ? ctx.triggerRef : ref}
      onBlur={
        ctx
          ? composeEventHandlers(onBlur, (event: React.FocusEvent<HTMLButtonElement>) => {
              // Drop any leftover suppression once focus leaves the trigger, so
              // the next genuine keyboard focus (Tab) shows the ring again.
              event.currentTarget.removeAttribute(SUPPRESSION_ATTR);
            })
          : onBlur
      }
      {...props}
    />
  );
}

export function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = "center",
  collisionPadding = 8,
  onCloseAutoFocus,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Content>>;
}) {
  const ctx = useDropdownMenuFocusContext();
  const closeModalityRef = React.useRef<CloseModality | null>(null);

  // Track the most recent input modality while the menu is open. The closing
  // interaction (click item / click outside / Esc / Enter) fires a
  // pointerdown/keydown on the document (capture phase) before Radix closes +
  // restores focus, so the ref is already set by the time we read it below.
  React.useEffect(() => {
    closeModalityRef.current = null;
    const onPointerDown = () => {
      closeModalityRef.current = "pointer";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Ignore pure modifier / shortcut presses; they aren't focus navigation.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      closeModalityRef.current = "keyboard";
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Effect Event: reads refs but is only ever called from Radix's close
  // handler (not during render), so it stays compliant with react-hooks/refs.
  const handleCloseAutoFocus = React.useEffectEvent(() => {
    const trigger = ctx?.triggerRef.current;
    if (!trigger) return;
    if (closeModalityRef.current === "pointer") {
      // Runs synchronously inside FocusScope's setTimeout, *before* Radix
      // calls focus(trigger), so the attribute is in place before the ring
      // would paint — no flicker.
      trigger.setAttribute(SUPPRESSION_ATTR, "");
    } else {
      trigger.removeAttribute(SUPPRESSION_ATTR);
    }
  });

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        onCloseAutoFocus={composeEventHandlers(onCloseAutoFocus, handleCloseAutoFocus)}
        className={cn(
          "z-50 min-w-40 max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-auto rounded-md border border-border bg-surface p-1.5 text-foreground shadow-lg outline-none",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
  icon?: React.ReactNode;
  ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Item>>;
}) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex h-9 w-full cursor-default select-none items-center gap-2 rounded px-2 text-left text-sm text-foreground-muted outline-none transition-colors focus:bg-surface-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownMenuLabel({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
  ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Label>>;
}) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & {
  ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Separator>>;
}) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn("-mx-1.5 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuSub,
};