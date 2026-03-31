# Card Association System — Design Spec

**Date:** 2026-03-30
**Status:** Draft
**Branch:** camera-only-test
**Depends on:** Camera-only focus model, card factory, frustum layout

---

## 1. Purpose

A system for spatially and logically associating cards in the 3D dashboard. Cards can magnetically attach at edges (physical bond, move as unit) or belong to logical groups (associated but spatially independent). Both relationships are recursive — groups of groups use the same code path. Attachment configurations are saveable and restorable.

---

## 2. Two Kinds of Association

### 2.1 Magnetic Attachment

Physical edge-snapping. Cards share an edge, move as one rigid unit, and stay attached in the ring overview. A unifying group title bar spans the composite.

Use cases: terminal + browser side-car, agent-to-agent chat card joining two terminal cards.

### 2.2 Logical Grouping

Association without physical attachment. Cards know they belong together but occupy independent positions in the ring. On focus, they assemble. On unfocus, they return to individual ring positions.

Behavior is configurable via a `GROUP_PERSISTS_IN_RING` flag — when true, logically grouped cards also share a ring position (same as magnetic). When false (default), they dissolve to individual ring slots on unfocus.

---

## 3. Attachment Gestures

### 3.1 Three Attach Modes

| Gesture | Mode | Behavior |
|---------|------|----------|
| Drag + release (edges overlapping) | **Basic attach** | Cards snap together at touching edges. Both keep their current sizes. |
| Shift + drag to edge | **Size-match attach** | Dragged card's touching edge resizes to match target card's edge length. Cards align and center on shared edge. Terminal cols/rows unchanged — card scales only. |
| Ctrl + drag to edge | **Optimize attach** | Edges match + terminals mutate to identical dimensions. Maximizes like single-thumbnail-click focus. |

### 3.2 Attachable Edges

All 4 edges: left, right, bottom, top. Top attachment places the new card above the existing card's title bar. The group title bar (§4.1) appears at the topmost edge of the full composite — always above all member cards and their individual title bars.

### 3.3 Commitment Threshold — Magnet Icon

Attach and detach both use a timed commitment model to prevent accidental operations.

**Attach flow:**

1. Drag card toward another card's edge
2. Edges enter proximity zone → **gray magnet icon appears** at the junction, glowing edge effect begins
3. Hold edges together → icon **darkens progressively over ~1 second**, edge glow solidifies
4. **Release before icon solidifies** → interaction treated as accidental. Both cards animate back to their pre-drag positions. No bond formed.
5. **Hold until icon solidifies (~1s)** → bond confirmed. Group title bar appears. Cards are magnetically attached.

**Detach flow:**

1. Drag an individual card's title bar away from its group
2. **Dark magnet icon appears** at the breaking edge and **fades progressively over ~1 second**
3. **Release before icon fully fades** → snap back to attached position. Bond preserved. Accidental detach prevented.
4. **Hold until icon disappears (~1s)** → detachment confirmed. Card is free. Group title bar adjusts (shrinks to remaining members) or disappears (if only one card remains).

The icon visual combines a recognizable magnet/horseshoe shape with an abstract glowing junction effect that solidifies or dissolves. Exact visual treatment TBD — the interaction model (proximity + timing + commitment threshold) is the specification.

---

## 4. Group Title Bar

### 4.1 Appearance

When cards magnetically attach, a **unifying title bar** appears spanning the full width (or height, depending on attachment axis) of the composite. Each original card retains its own title bar.

Recursive: a group of groups gets its own higher-level unifying title bar.

### 4.2 Drag Behavior

- **Drag an original card's title bar** → initiates detach flow (see §3.3)
- **Drag the group title bar** → moves the entire group as a rigid unit

### 4.3 Title Bar Determines Scope

Whichever title bar is active (last clicked/grabbed) defines the scope for all operations:

| Active title bar | Shift+Tab cycles through | Focus/unfocus operates on |
|-----------------|-------------------------|--------------------------|
| Individual card | That card's siblings within its immediate group | That card |
| Group title bar | The group as one unit within its parent context | The entire group as one card |
| Parent group title bar | Sub-groups as units | The parent group |

This is fully recursive — each nesting level has its own title bar and its own scope.

---

## 5. Focus Behavior (Recursive)

**A group IS a card.** The same focus code path handles all levels:

- **Focus (click thumbnail or title bar):** Camera zooms to fill viewport with the target — whether it's a single card, a magnetic pair, or a group of groups.
- **Shift+Tab:** Cycles through members at the scope defined by the active title bar. Each member gets full-viewport focus, same animation as single-card focus today.
- **Escape:** Returns to parent scope. From zoomed member → group view. From group view → ring.

### 5.1 Single Card Focus

Camera zooms to fill viewport. Same as current `focusTerminal()`.

### 5.2 Magnetic Group Focus

Camera zooms to fill viewport with the composite shape. The group occupies one "card slot" in the focus system.

### 5.3 Shift+Tab Within Group

When an individual title bar is active, shift+tab cycles through group members. Each member fills the viewport on its turn — same code path as current multi-focus shift+tab cycling.

When the group title bar is active and the group is part of a larger multi-focus set, shift+tab cycles through that larger set, treating this group as one unit.

---

## 6. Ring Behavior

- **Magnetically attached** cards occupy one ring position as a composite shape. The group is one ring node.
- **Logically grouped** (unattached) cards return to individual ring positions by default. Configurable via `GROUP_PERSISTS_IN_RING` flag.

---

## 7. Index View

An exploded view mode that temporarily separates all cards for visibility and reassignment.

1. Trigger index view (gesture TBD)
2. All cards fly apart to individual positions — magnetic bonds visually stretch/ghost but don't break
3. User can see every card, reassign associations, drag new attachments
4. **Esc** dismisses the index — cards animate back to their associated state (magnetic groups reform, logical groups reassemble)

Index view is non-destructive by default. Associations only change if the user explicitly modifies them during the index.

---

## 8. Persistence

Attachment configurations are saveable:

- Which cards are magnetically attached
- Edge relationships (which edge of A connects to which edge of B)
- Logical group membership
- Group names (user-assignable)
- Nesting structure (group of groups hierarchy)

This integrates with the workspace/scene system (TASKLIST F6). A saved scene includes card positions, sizes, AND association state.

---

## 9. Data Model

### 9.1 Association Node (Recursive)

```
AssociationNode: {
  id: string,
  type: 'card' | 'magnetic-group' | 'logical-group',
  children: AssociationNode[],        // recursive — groups contain nodes
  attachments: Attachment[],          // magnetic edge bonds (magnetic-group only)
  titleBar: TitleBarState,            // each node level has its own
  persistInRing: boolean,             // GROUP_PERSISTS_IN_RING per node
}

Attachment: {
  cardA: string,                      // id of first card
  edgeA: 'top' | 'bottom' | 'left' | 'right',
  cardB: string,                      // id of second card
  edgeB: 'top' | 'bottom' | 'left' | 'right',
  mode: 'basic' | 'size-match' | 'optimize',
}

TitleBarState: {
  label: string,                      // user-assignable name
  active: boolean,                    // is this the scope-defining title bar
}
```

### 9.2 Relationship to Existing Terminal Map

The current `terminals` Map in dashboard.mjs holds flat card objects. The association system adds a tree layer on top:

- Each terminal card is a leaf `AssociationNode` with `type: 'card'`
- Magnetic attachment creates a parent node with `type: 'magnetic-group'`
- Logical grouping creates a parent node with `type: 'logical-group'`
- The tree can be N levels deep

The existing focus/layout code needs to accept an `AssociationNode` anywhere it currently accepts a terminal name. This is the recursive refactor.

---

## 10. Constraints

| Constraint | Reason |
|-----------|--------|
| Camera-only focus model | Cards never resize on focus. Camera moves. Group focus = camera pulls back to fit composite. |
| No CSS border/box-shadow on `.terminal-3d` | Re-rasterization under CSS3D transforms. Group title bar must not trigger this. |
| 4x scale trick | Group compositing must preserve oversized DOM + 0.25 CSS3DObject scale. |
| Coordinate-based hit testing | Group title bar clicks must use coordinate checking, not `e.target.closest()`. |
| `<object>` isolation for SVG | Magnetic attachment doesn't change how terminals render — only spatial arrangement. |

---

## 11. Interaction with Z-Slide Removal

The current active-terminal Z-slide (`READING_Z_OFFSET = 25`, `_savedZ` tracking) is being removed (Task #4). The association system replaces the need for Z-based active indication — the active title bar scope and gold header background are the indicators. The `_savedZ`, `_layoutZ`, and `READING_Z_OFFSET` code paths are dead after this design is implemented.

---

## 12. Sidebar Thumbnails

- **Magnetic group:** One composite thumbnail at one sidebar position. Clicking it focuses the group.
- **Logical group:** Each member has its own thumbnail. A subtle visual indicator (bracket, shared color dot) shows group membership.
- **Nested groups:** The outermost group determines the thumbnail representation.

---

## 13. Implementation Decomposition

This design should be built in phases:

1. **Phase 1:** Magnetic edge detection + basic attach/detach with commitment threshold icon
2. **Phase 2:** Group title bar (appearance, drag-to-move, drag-to-detach)
3. **Phase 3:** Recursive focus — group-as-card for focus, shift+tab, escape
4. **Phase 4:** Three attach modes (basic, size-match, optimize)
5. **Phase 5:** Index view (exploded view, reassignment, dismiss)
6. **Phase 6:** Persistence (save/restore association state with workspace system)

Each phase is independently testable and shippable.

---

## 14. Open Items

- Index view trigger gesture (dedicated key? button? menu?)
- Group title bar exact visual treatment (height, color, how it spans attachment axis)
- Maximum group depth (unlimited? practical limit?)
- How agent-to-agent chat cards work internally (separate spec needed)
- How browser cards interact with terminal resize mutations in optimize-attach mode
