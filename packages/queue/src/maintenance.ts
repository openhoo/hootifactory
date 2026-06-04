export interface MaintenanceTask {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

export interface MaintenanceScheduler {
  runDue(now?: number): Promise<void>;
  nextRunAt(name: string): number | undefined;
}

export function createMaintenanceScheduler(tasks: MaintenanceTask[]): MaintenanceScheduler {
  const nextRunAtByName = new Map(tasks.map((task) => [task.name, 0]));
  return {
    async runDue(now = Date.now()) {
      for (const task of tasks) {
        const nextRunAt = nextRunAtByName.get(task.name) ?? 0;
        if (now < nextRunAt) continue;
        nextRunAtByName.set(task.name, now + Math.max(0, task.intervalMs));
        await task.run();
      }
    },
    nextRunAt(name) {
      return nextRunAtByName.get(name);
    },
  };
}
