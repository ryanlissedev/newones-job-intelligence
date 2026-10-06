"use client";

import {
  Activity,
  Database,
  LayoutDashboard,
  MessageSquare,
  Search,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  canAccessBronnen,
  sessionRoleSchema,
} from "@/app/bronnen/bronnen-window";
import { authClient } from "@/lib/auth-client";

import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

const navigationItems = [
  {
    href: "/",
    icon: LayoutDashboard,
    label: "Overzicht",
  },
  {
    href: "/jobs",
    icon: Search,
    label: "Zoeken",
  },
  {
    href: "/bronnen",
    icon: Activity,
    label: "Bronnen",
  },
  {
    href: "/exports",
    icon: Upload,
    label: "Exports",
  },
  {
    href: "/chat",
    icon: MessageSquare,
    label: "Marktvragen",
  },
] as const;

const ForbiddenToastListener = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("toast") !== "forbidden") {
      return;
    }
    toast.error("Je hebt geen toegang tot de bronmonitor.");
    router.replace("/");
  }, [router, searchParams]);

  return null;
};

const Header = () => {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const parsedSession = sessionRoleSchema.safeParse(session);
  const canViewBronnen =
    mounted &&
    canAccessBronnen(
      parsedSession.success ? parsedSession.data.user.role : null
    );

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <Suspense fallback={null}>
        <ForbiddenToastListener />
      </Suspense>
      <div className="mx-auto flex min-h-16 w-full max-w-[1600px] items-center gap-2 px-3 sm:gap-6 sm:px-6">
        <Link
          aria-label="Newones — overzicht"
          className="flex min-h-11 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="/"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded bg-primary/15 text-primary">
            <Database aria-hidden="true" className="size-4" />
          </span>
          <span className="font-display text-sm font-semibold tracking-tight whitespace-nowrap">
            Job Intelligence
          </span>
          <span className="hidden font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase sm:inline">
            Newones
          </span>
        </Link>

        <nav aria-label="Hoofdnavigatie" className="flex items-center gap-1">
          {navigationItems.map(({ href, icon: Icon, label }) => {
            if (
              href === "/bronnen" &&
              (!mounted || isPending || !canViewBronnen)
            ) {
              return null;
            }

            const isActive =
              href === "/" ? pathname === href : pathname.startsWith(href);

            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`min-h-11 items-center gap-2 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                } ${href === "/" ? "hidden sm:flex" : "flex"}`}
                href={href}
                key={href}
              >
                <Icon aria-hidden="true" className="size-4" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
};

export default Header;
