"use client";

import {
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  STAGING_ENVIRONMENTS,
  type StagingAssignments,
  type StagingDestination,
  type StagingEnvironment,
  type StagingStartedAt,
} from "@/types/staging";
import type { User } from "@/types/user";

type ZoneId = "pool" | StagingEnvironment;

type StagingDashboardProps = {
  users: User[];
  initialAssignments: StagingAssignments;
  initialStartedAt: StagingStartedAt;
};

type MoveResponse = {
  ok: boolean;
  error?: string;
  assignments?: StagingAssignments;
  startedAt?: StagingStartedAt;
  occupiedByName?: string;
  notification?: {
    userName: string;
    previousEnvironment: StagingEnvironment | null;
    nextEnvironment: StagingEnvironment | null;
  } | null;
};

type NotifyResponse = {
  ok: boolean;
  error?: string;
};

type StatusResponse = {
  ok: boolean;
  assignments?: StagingAssignments;
  startedAt?: StagingStartedAt;
};

type EnvironmentMeta = {
  title: string;
  subtitle: string;
  tintClass: string;
  activeClass: string;
  badgeClass: string;
  nameClass: string;
};

const environmentMeta: Record<StagingEnvironment, EnvironmentMeta> = {
  backend: {
    title: "backend",
    subtitle: "Core APIs and services",
    tintClass:
      "bg-gradient-to-br from-[#001f3f]/30 via-[#001f3f]/14 to-transparent",
    activeClass: "ring-[#001f3f]/45 shadow-[0_20px_55px_rgba(0,31,63,0.30)]",
    badgeClass: "bg-[#001f3f] text-white",
    nameClass: "text-[#001f3f]",
  },
  "payer-web": {
    title: "payer-web",
    subtitle: "Web checkout flow",
    tintClass:
      "bg-gradient-to-br from-[#ef4444]/25 via-[#fb7185]/14 to-transparent",
    activeClass: "ring-[#ef4444]/40 shadow-[0_20px_55px_rgba(239,68,68,0.28)]",
    badgeClass: "bg-[#ef4444] text-white",
    nameClass: "text-[#ef4444]",
  },
  "business-web": {
    title: "business-web",
    subtitle: "Business portal",
    tintClass:
      "bg-gradient-to-br from-[#eab308]/32 via-[#f59e0b]/16 to-transparent",
    activeClass: "ring-[#eab308]/45 shadow-[0_20px_55px_rgba(234,179,8,0.30)]",
    badgeClass: "bg-[#eab308] text-[#001f3f]",
    nameClass: "text-[#b45309]",
  },
};

function formatStartedAt(value: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const timeText = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(date);

  return `${timeText} (DE time)`;
}

type UserCardVisualProps = {
  user: User;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
  disabledAction?: boolean;
  isOverlay?: boolean;
  size?: "pool" | "environment";
};

function UserCardVisual({
  user,
  subtitle,
  actionLabel,
  onAction,
  disabledAction,
  isOverlay = false,
  size = "environment",
}: UserCardVisualProps) {
  const isPoolSize = size === "pool";
  const avatarSize = isPoolSize ? 64 : 46;

  return (
    <div
      className={[
        "relative overflow-hidden border border-white/65",
        "bg-gradient-to-br from-white/70 via-white/40 to-[#c7f9cc]/55",
        isPoolSize
          ? "rounded-3xl backdrop-blur-xl px-3 py-3 shadow-[0_16px_34px_rgba(0,31,63,0.16)]"
          : "rounded-2xl backdrop-blur-xl px-2 py-[0.7rem] shadow-[0_10px_20px_rgba(0,31,63,0.14)]",
        isOverlay ? "w-[320px]" : "",
      ].join(" ")}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(255,255,255,0.85),transparent_55%)]" />

      <div
        className={[
          "relative flex items-center",
          isPoolSize ? "gap-3" : "gap-2",
        ].join(" ")}
      >
        <Image
          src={user.picture}
          alt={`${user.name} avatar`}
          width={avatarSize}
          height={avatarSize}
          className={[
            "rounded-full border border-white/80 bg-[#001f3f]/10",
            isPoolSize
              ? "h-16 w-16 shadow-[0_10px_24px_rgba(0,31,63,0.2)]"
              : "h-[46px] w-[46px] shadow-[0_8px_16px_rgba(0,31,63,0.16)]",
          ].join(" ")}
        />

        <div className="min-w-0 flex-1">
          <p
            className={[
              "truncate font-semibold leading-none text-[#001f3f]",
              isPoolSize ? "text-base" : "text-sm",
            ].join(" ")}
          >
            {user.name}
          </p>
          {subtitle ? (
            <p
              className={
                isPoolSize
                  ? "text-sm text-[#001f3f]/70"
                  : "text-xs font-medium text-[#001f3f]/70"
              }
            >
              {subtitle}
            </p>
          ) : null}
        </div>

        {actionLabel && onAction ? (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onAction}
            disabled={disabledAction}
            className={[
              isPoolSize
                ? "rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200"
                : "rounded-xl px-3 py-1.5 text-xs font-semibold transition-all duration-200",
              "border cursor-pointer border-white/70 shadow-[0_8px_20px_rgba(0,31,63,0.2)]",
              "bg-[#001f3f]/88 text-white hover:bg-[#001f3f]",
              disabledAction ? "cursor-not-allowed opacity-55" : "",
            ].join(" ")}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type DraggableUserCardProps = {
  user: User;
  sourceZone: ZoneId;
  startedAt?: string | null;
  activeDraggableId: string | null;
  pendingUserId: string | null;
  onMove: (
    userId: string,
    destination: StagingDestination,
    sourceEnvironment: StagingEnvironment | null,
  ) => Promise<void>;
};

function DraggableUserCard({
  user,
  sourceZone,
  startedAt = null,
  activeDraggableId,
  pendingUserId,
  onMove,
}: DraggableUserCardProps) {
  const draggableId = draggableIdFor(user.id, sourceZone);

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: draggableId,
    });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
      }
    : undefined;

  const busy = pendingUserId !== null;

  const formattedStartedAt = formatStartedAt(startedAt);
  const subtitle =
    sourceZone === "pool"
      ? ""
      : formattedStartedAt
        ? `Started at ${formattedStartedAt}`
        : `Using ${sourceZone}`;
  const actionLabel = sourceZone === "pool" ? undefined : "Remove";
  const onAction =
    sourceZone === "pool"
      ? undefined
      : () => void onMove(user.id, "pool", sourceZone);

  return (
    <article
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={[
        sourceZone === "pool" ? "w-full sm:w-[48%]" : "w-full",
        "cursor-grab touch-none transition-[transform,opacity] duration-200 active:cursor-grabbing",
        isDragging ? "opacity-25" : "",
        activeDraggableId === draggableId ? "scale-[1.01]" : "",
      ].join(" ")}
    >
      <UserCardVisual
        user={user}
        subtitle={subtitle}
        actionLabel={actionLabel}
        disabledAction={busy}
        onAction={onAction}
        size={sourceZone === "pool" ? "pool" : "environment"}
      />
    </article>
  );
}

type PoolZoneProps = {
  users: User[];
  activeDraggableId: string | null;
  hoveredZone: ZoneId | null;
  pendingUserId: string | null;
  onMove: (
    userId: string,
    destination: StagingDestination,
    sourceEnvironment: StagingEnvironment | null,
  ) => Promise<void>;
};

function PoolZone({
  users,
  activeDraggableId,
  hoveredZone,
  pendingUserId,
  onMove,
}: PoolZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: "drop-pool",
  });

  const isActiveTarget =
    Boolean(activeDraggableId) && (isOver || hoveredZone === "pool");

  return (
    <section
      ref={setNodeRef}
      className={[
        "glass-panel relative min-h-[520px] rounded-[2rem] p-5 transition-all duration-250 md:p-6",
        isActiveTarget
          ? "scale-[1.01] ring-2 ring-[#001f3f]/30 shadow-[0_20px_55px_rgba(0,31,63,0.24)]"
          : "shadow-[0_15px_45px_rgba(0,31,63,0.16)]",
      ].join(" ")}
    >
      <div className="pointer-events-none absolute inset-0 rounded-[2rem] bg-gradient-to-br from-white/45 via-transparent to-[#c7f9cc]/28" />

      <div className="relative mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[#001f3f]">
            FLIZ tech (awesome) team
          </h2>
          <p className="mt-1 text-sm text-[#001f3f]/68">
            Drag someone into one or more staging cards
          </p>
        </div>
        <span className="rounded-full border border-white/75 bg-white/55 px-3 py-1 text-xs font-semibold text-[#001f3f]">
          {users.length} available
        </span>
      </div>

      <div className="relative flex flex-wrap items-start gap-3">
        {users.length > 0 ? (
          users.map((user) => (
            <DraggableUserCard
              key={user.id}
              user={user}
              sourceZone="pool"
              activeDraggableId={activeDraggableId}
              pendingUserId={pendingUserId}
              onMove={onMove}
            />
          ))
        ) : (
          <div className="rounded-3xl border border-white/70 bg-white/35 p-5 text-center text-sm font-medium text-[#001f3f]/58">
            Everyone is occupying a staging slot
          </div>
        )}
      </div>
    </section>
  );
}

type EnvironmentZoneProps = {
  environment: StagingEnvironment;
  user: User | null;
  startedAt: string | null;
  activeDraggableId: string | null;
  hoveredZone: ZoneId | null;
  pendingUserId: string | null;
  onMove: (
    userId: string,
    destination: StagingDestination,
    sourceEnvironment: StagingEnvironment | null,
  ) => Promise<void>;
};

function EnvironmentZone({
  environment,
  user,
  startedAt,
  activeDraggableId,
  hoveredZone,
  pendingUserId,
  onMove,
}: EnvironmentZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${environment}`,
  });

  const meta = environmentMeta[environment];
  const isActiveTarget =
    Boolean(activeDraggableId) && (isOver || hoveredZone === environment);

  return (
    <section
      ref={setNodeRef}
      className={[
        "glass-panel relative min-h-[120px] rounded-[1.5rem] p-4 transition-all duration-250",
        isActiveTarget
          ? `scale-[1.01] ring-2 ${meta.activeClass}`
          : "shadow-[0_12px_35px_rgba(0,31,63,0.14)]",
      ].join(" ")}
    >
      <div
        className={`pointer-events-none absolute inset-0 rounded-[1.5rem] ${meta.tintClass}`}
      />

      <div className="relative mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className={`text-lg font-semibold ${meta.nameClass}`}>
            {meta.title}
          </h3>
          <p className="mt-1 text-xs text-[#001f3f]/65">{meta.subtitle}</p>
        </div>

        <span
          className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${meta.badgeClass}`}
        >
          {user ? "Occupied" : "Free"}
        </span>
      </div>

      <div className="relative">
        {user ? (
          <DraggableUserCard
            user={user}
            sourceZone={environment}
            startedAt={startedAt}
            activeDraggableId={activeDraggableId}
            pendingUserId={pendingUserId}
            onMove={onMove}
          />
        ) : (
          <div className="rounded-2xl border border-white/70 bg-white/35 p-4 text-center text-sm font-medium text-[#001f3f]/58">
            Drop one user here
          </div>
        )}
      </div>
    </section>
  );
}

function zoneFromDropId(dropId: string | undefined): ZoneId | null {
  if (!dropId) {
    return null;
  }

  if (dropId === "drop-pool") {
    return "pool";
  }

  if (!dropId.startsWith("drop-")) {
    return null;
  }

  const candidate = dropId.slice(5);

  return STAGING_ENVIRONMENTS.includes(candidate as StagingEnvironment)
    ? (candidate as StagingEnvironment)
    : null;
}

function draggableIdFor(userId: string, sourceZone: ZoneId) {
  return `${sourceZone}:${userId}`;
}

function parseDraggableId(value: string): {
  userId: string;
  sourceZone: ZoneId;
} | null {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  const sourceZoneRaw = value.slice(0, separatorIndex);
  const userId = value.slice(separatorIndex + 1);

  if (!userId) {
    return null;
  }

  if (sourceZoneRaw === "pool") {
    return { userId, sourceZone: "pool" };
  }

  return STAGING_ENVIRONMENTS.includes(sourceZoneRaw as StagingEnvironment)
    ? {
        userId,
        sourceZone: sourceZoneRaw as StagingEnvironment,
      }
    : null;
}

function assignmentsEqual(a: StagingAssignments, b: StagingAssignments) {
  for (const environment of STAGING_ENVIRONMENTS) {
    if (a[environment] !== b[environment]) {
      return false;
    }
  }

  return true;
}

function startedAtEqual(a: StagingStartedAt, b: StagingStartedAt) {
  for (const environment of STAGING_ENVIRONMENTS) {
    if (a[environment] !== b[environment]) {
      return false;
    }
  }

  return true;
}

export default function StagingDashboard({
  users,
  initialAssignments,
  initialStartedAt,
}: StagingDashboardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 90,
        tolerance: 5,
      },
    }),
  );

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );

  const [assignments, setAssignments] =
    useState<StagingAssignments>(initialAssignments);
  const [startedAt, setStartedAt] =
    useState<StagingStartedAt>(initialStartedAt);
  const [activeDraggableId, setActiveDraggableId] = useState<string | null>(null);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [hoveredZone, setHoveredZone] = useState<ZoneId | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let isActive = true;
    let inFlight = false;

    const refreshAssignments = async () => {
      if (!isActive || inFlight || pendingUserId) {
        return;
      }

      inFlight = true;

      try {
        const response = await fetch("/api/staging/status", {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as StatusResponse;

        if (!payload.ok || !payload.assignments || !payload.startedAt) {
          return;
        }

        setAssignments((current) =>
          assignmentsEqual(current, payload.assignments!)
            ? current
            : payload.assignments!,
        );
        setStartedAt((current) =>
          startedAtEqual(current, payload.startedAt!)
            ? current
            : payload.startedAt!,
        );
      } catch {
        // Poll quietly; explicit move/slack errors are surfaced elsewhere.
      } finally {
        inFlight = false;
      }
    };

    const intervalId = setInterval(() => {
      void refreshAssignments();
    }, 3000);

    void refreshAssignments();

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [pendingUserId]);

  const poolUsers = [...users].sort((a, b) => a.name.localeCompare(b.name));

  const environmentUsers = useMemo(() => {
    const map = new Map<StagingEnvironment, User | null>();

    for (const environment of STAGING_ENVIRONMENTS) {
      const userId = assignments[environment];
      map.set(environment, userId ? usersById.get(userId) || null : null);
    }

    return map;
  }, [assignments, usersById]);

  const activeUser = activeUserId ? usersById.get(activeUserId) || null : null;

  async function moveUser(
    userId: string,
    destination: StagingDestination,
    sourceEnvironment: StagingEnvironment | null,
  ) {
    if (pendingUserId) {
      return;
    }

    if (destination === "pool") {
      if (!sourceEnvironment) {
        return;
      }

      if (assignments[sourceEnvironment] !== userId) {
        return;
      }
    } else if (assignments[destination] === userId) {
      return;
    }

    setPendingUserId(userId);

    try {
      const response = await fetch("/api/staging/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId, destination, sourceEnvironment }),
      });

      const payload = (await response.json()) as MoveResponse;

      if (!response.ok || !payload.ok || !payload.assignments || !payload.startedAt) {
        if (payload.occupiedByName) {
          setMessage(
            payload.error ||
              `${destination} is already occupied by ${payload.occupiedByName}.`,
          );
        } else {
          setMessage(payload.error || "Could not update staging status.");
        }
        return;
      }

      setAssignments(payload.assignments);
      setStartedAt(payload.startedAt);
      setMessage("");

      if (payload.notification) {
        const slackResponse = await fetch("/api/staging/notify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload.notification),
        });

        const slackPayload = (await slackResponse.json()) as NotifyResponse;

        if (!slackResponse.ok || !slackPayload.ok) {
          setMessage(
            `Status updated, but Slack failed: ${slackPayload.error || "unknown error"}.`,
          );
          return;
        }

        setMessage("");
      }
    } catch {
      setMessage("Could not reach server.");
    } finally {
      setPendingUserId(null);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const activeId = String(event.active.id);
    const parsed = parseDraggableId(activeId);

    if (!parsed) {
      setActiveDraggableId(null);
      setActiveUserId(null);
      return;
    }

    setActiveDraggableId(activeId);
    setActiveUserId(parsed.userId);
  }

  function handleDragOver(event: DragOverEvent) {
    setHoveredZone(
      zoneFromDropId(event.over?.id ? String(event.over.id) : undefined),
    );
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const parsed = parseDraggableId(activeId);
    const destination = zoneFromDropId(
      event.over?.id ? String(event.over.id) : undefined,
    );

    setActiveDraggableId(null);
    setActiveUserId(null);
    setHoveredZone(null);

    if (!destination || !parsed) {
      return;
    }

    await moveUser(
      parsed.userId,
      destination,
      parsed.sourceZone === "pool" ? null : parsed.sourceZone,
    );
  }

  function handleDragCancel() {
    setActiveDraggableId(null);
    setActiveUserId(null);
    setHoveredZone(null);
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8 md:px-7 md:py-10">
      <div className="glass-orb pointer-events-none absolute -left-16 -top-14 h-72 w-72 rounded-full bg-[#c7f9cc]/85 blur-3xl" />
      <div className="glass-orb-alt pointer-events-none absolute -right-16 top-16 h-80 w-80 rounded-full bg-[#001f3f]/16 blur-3xl" />
      <div className="glass-orb pointer-events-none absolute bottom-[-120px] left-1/3 h-80 w-80 rounded-full bg-white/60 blur-3xl" />

      <div className="relative mx-auto w-full max-w-7xl">
        {message ? (
          <div className="mb-4 flex justify-center">
            <div className="rounded-2xl border border-white/80 bg-white/55 px-4 py-2 text-sm font-medium text-[#001f3f]">
              {message}
            </div>
          </div>
        ) : null}

        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="grid gap-5 lg:grid-cols-[1.35fr_0.72fr]">
            <PoolZone
              users={poolUsers}
              activeDraggableId={activeDraggableId}
              hoveredZone={hoveredZone}
              pendingUserId={pendingUserId}
              onMove={moveUser}
            />

            <div className="grid grid-cols-1 gap-3">
              {STAGING_ENVIRONMENTS.map((environment) => (
                <EnvironmentZone
                  key={environment}
                  environment={environment}
                  user={environmentUsers.get(environment) || null}
                  startedAt={startedAt[environment]}
                  activeDraggableId={activeDraggableId}
                  hoveredZone={hoveredZone}
                  pendingUserId={pendingUserId}
                  onMove={moveUser}
                />
              ))}
            </div>
          </div>

          <DragOverlay>
            {activeUser ? (
              <UserCardVisual
                user={activeUser}
                subtitle="Moving between staging slots"
                isOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </main>
  );
}
