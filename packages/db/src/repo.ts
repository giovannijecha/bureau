// TaskRepo — persistence for the Task aggregate. Saves/loads the whole
// aggregate atomically; the engine layer holds an instance and is the only
// caller. Pure storage: no domain logic lives here (that's @bureau/core).

import { eq } from "drizzle-orm";
import type { Task, TaskId } from "@bureau/core";
import type { BureauDb } from "./client.js";
import { tasks, steps, gates, artifacts, decisionLog } from "./schema.js";
import { taskToRows, rowsToTask } from "./mapper.js";

export class TaskRepo {
  constructor(private readonly db: BureauDb) {}

  /** Insert or fully replace a task and all of its children, atomically. */
  save(task: Task): void {
    const rows = taskToRows(task);
    this.db.transaction((tx) => {
      // Replace-children strategy: clears removed steps/gates/etc. too.
      tx.delete(decisionLog).where(eq(decisionLog.taskId, task.id)).run();
      tx.delete(artifacts).where(eq(artifacts.taskId, task.id)).run();
      tx.delete(gates).where(eq(gates.taskId, task.id)).run();
      tx.delete(steps).where(eq(steps.taskId, task.id)).run();
      tx.insert(tasks).values(rows.task).onConflictDoUpdate({ target: tasks.id, set: rows.task }).run();
      if (rows.steps.length) tx.insert(steps).values(rows.steps).run();
      if (rows.gates.length) tx.insert(gates).values(rows.gates).run();
      if (rows.artifacts.length) tx.insert(artifacts).values(rows.artifacts).run();
      if (rows.decisionLog.length) tx.insert(decisionLog).values(rows.decisionLog).run();
    });
  }

  /** Load a full task aggregate, or null if it does not exist. */
  load(id: TaskId): Task | null {
    const taskRow = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!taskRow) return null;
    return rowsToTask({
      task: taskRow,
      steps: this.db.select().from(steps).where(eq(steps.taskId, id)).all(),
      gates: this.db.select().from(gates).where(eq(gates.taskId, id)).all(),
      artifacts: this.db.select().from(artifacts).where(eq(artifacts.taskId, id)).all(),
      decisionLog: this.db.select().from(decisionLog).where(eq(decisionLog.taskId, id)).all(),
    });
  }

  /** All tasks, oldest first (id as a stable tie-breaker on equal createdAt). */
  list(): Task[] {
    const ids = this.db.select({ id: tasks.id }).from(tasks).orderBy(tasks.createdAt, tasks.id).all();
    return ids
      .map((r) => this.load(r.id as TaskId))
      .filter((t): t is Task => t !== null);
  }

  /** Delete a task; children cascade via the foreign-key constraint. */
  delete(id: TaskId): void {
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }
}
