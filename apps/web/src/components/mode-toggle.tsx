"use client";

import { Button } from "@ji/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ji/ui/components/dropdown-menu";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";

export const ModeToggle = () => {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        <span className="sr-only">Thema wijzigen</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          Licht
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          Donker
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          Systeem
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
