import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(...registerables);

const ES_URL  = 'https://vpc-dx-observer-prod-domain-kr4y2j7e4rfn527rrw734bgigq.us-east-1.es.amazonaws.com';
const INDEX_AE   = 'ae-startup-events-2';
const INDEX_GDEV = 'gdev-events-1';

interface NameDuration {
  name: string;
  duration_ms: number;
}

interface SpringBean extends NameDuration {
  class?: string;
}

interface AeDoc {
  '@timestamp': string;
  user: string;
  branch: string;
  commit: string;
  latest_tag?: string;
  agent_id?: string;
  startup_type?: string;
  tomcat_metrics: NameDuration[];
  spring_beans: SpringBean[];
}

interface GdevPhase {
  '@timestamp': string;
  tag: string;
  duration_seconds: number;
}

interface StartupRow {
  ae: AeDoc;
  phases?: GdevPhase[];  // populated lazily on expand
  loadingPhases?: boolean;
  expanded?: boolean;
  // Duration of gdev's whole on_start pipeline (the `tag=all` event in
  // gdev-events-1): gradle -> docker -> webapp -> daemons. Excludes agent
  // provisioning / file sync, which happen before on_start.
  pipelineSeconds?: number;
  // gradle-build + webapp-startup for this run — the same definition as the
  // DX "Total GDev Startup Time" KPI (which reports team-wide medians of
  // these two phases). Excludes docker build and daemons.
  kpiSeconds?: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  // filter state
  filterUser = '';
  filterBranch = '';
  filterStartupType = '';
  filterLatestTag = '';
  daysBack = 7;

  // result state
  startups: StartupRow[] = [];
  loading = false;
  errorMsg = '';

  // facet values, populated from data
  knownUsers: string[] = [];
  knownBranches: string[] = [];
  knownStartupTypes = ['', 'full_start', 'webapp_restart', 'unknown'];
  knownLatestTags: string[] = [];

  // chart
  private chart: Chart | null = null;

  constructor(private http: HttpClient, private cd: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.fetch();
  }

  fetch(): void {
    this.loading = true;
    this.errorMsg = '';

    const filters: any[] = [
      { range: { '@timestamp': { gte: `now-${this.daysBack}d` } } }
    ];
    if (this.filterUser) {
      filters.push({ term: { user: this.filterUser } });
    }
    if (this.filterBranch) {
      filters.push({ term: { branch: this.filterBranch } });
    }
    if (this.filterStartupType) {
      filters.push({ term: { startup_type: this.filterStartupType } });
    }
    if (this.filterLatestTag) {
      filters.push({ term: { latest_tag: this.filterLatestTag } });
    }

    const body = {
      size: 200,
      sort: [{ '@timestamp': 'desc' }],
      query: { bool: { filter: filters } }
    };

    this.http.post<any>(`${ES_URL}/${INDEX_AE}/_search`, body).subscribe({
      next: (r) => {
        const hits = (r?.hits?.hits ?? []) as any[];
        this.startups = hits.map((h: any): StartupRow => ({
          ae: h._source as AeDoc,
          expanded: false
        }));
        this.refreshFacets();
        this.loadGdevTotals();
        this.loading = false;
        this.cd.detectChanges();
      },
      error: (err) => {
        this.errorMsg = `Fetch failed: ${err?.message ?? err}`;
        this.loading = false;
        this.cd.detectChanges();
      }
    });
  }

  // Parses an ES timestamp to epoch ms, treating suffix-less values as UTC
  // (gdev-events-1 stores @timestamp without a timezone suffix).
  private parseTsMs(ts: string): number {
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(ts);
    return new Date(hasTz ? ts : ts + 'Z').getTime();
  }

  // Fetches the gdev phase events needed for the two per-row totals in ONE
  // query for every listed startup:
  //  - `all`            → pipelineSeconds (whole on_start wall clock)
  //  - gradle-build / gradle-rebuild + webapp-startup / webapp-svc-startup
  //                     → kpiSeconds (gradle + webapp, same definition as the
  //                       DX "Total GDev Startup Time" KPI, which reports
  //                       team-wide medians of exactly these two phases)
  // The `all` event completes a few minutes AFTER the AE doc (daemons run
  // after webapp turns healthy); gradle/webapp complete BEFORE it.
  private loadGdevTotals(): void {
    if (!this.startups.length) {
      this.drawChart();
      return;
    }
    const times = this.startups.map(s => this.parseTsMs(s.ae['@timestamp']));
    const users = [...new Set(this.startups.map(s => s.ae.user))];
    const winStart = new Date(Math.min(...times) - 50 * 60 * 1000).toISOString();
    const winEnd = new Date(Math.max(...times) + 60 * 60 * 1000).toISOString();

    const body = {
      size: 5000,
      sort: [{ '@timestamp': 'asc' }],
      query: {
        bool: {
          filter: [
            { terms: { 'payload.tag.keyword': [
              'all', 'gradle-build', 'gradle-rebuild', 'webapp-startup', 'webapp-svc-startup'
            ] } },
            { terms: { user: users } },
            { range: { '@timestamp': { gte: winStart, lte: winEnd } } }
          ]
        }
      }
    };

    this.http.post<any>(`${ES_URL}/${INDEX_GDEV}/_search`, body).subscribe({
      next: (r) => {
        const byUser = new Map<string, { tag: string; tMs: number; seconds: number }[]>();
        for (const h of (r?.hits?.hits ?? []) as any[]) {
          const s = h._source;
          const tag = s?.payload?.tag ?? s?.tag;
          const durRaw = s?.payload?.duration ?? s?.duration;
          const dur = typeof durRaw === 'string' ? parseFloat(durRaw) : Number(durRaw);
          if (!tag || !isFinite(dur) || dur <= 0) continue;
          const list = byUser.get(s.user) ?? [];
          list.push({ tag, tMs: this.parseTsMs(s['@timestamp']), seconds: dur });
          byUser.set(s.user, list);
        }
        for (const row of this.startups) {
          const aeMs = this.parseTsMs(row.ae['@timestamp']);
          const events = byUser.get(row.ae.user) ?? [];

          // Whole-pipeline total: first `all` completing after the doc.
          const allEv = events.filter(e => e.tag === 'all' &&
            e.tMs >= aeMs - 60 * 1000 && e.tMs <= aeMs + 45 * 60 * 1000);
          row.pipelineSeconds = allEv.length ? allEv[0].seconds : undefined;

          // KPI total: latest gradle + latest webapp event belonging to this
          // run (same look-back window and latest-per-tag rule as the
          // expanded phase table, so the numbers always agree).
          const inRun = events.filter(e =>
            e.tMs >= aeMs - 45 * 60 * 1000 && e.tMs <= aeMs + 5 * 60 * 1000);
          const latest = (...tags: string[]) => {
            let best: { tMs: number; seconds: number } | undefined;
            for (const e of inRun) {
              if (tags.includes(e.tag) && (!best || e.tMs > best.tMs)) best = e;
            }
            return best;
          };
          const gradle = latest('gradle-build', 'gradle-rebuild');
          const webapp = latest('webapp-startup', 'webapp-svc-startup');
          row.kpiSeconds = gradle && webapp ? gradle.seconds + webapp.seconds : undefined;
        }
        this.drawChart();
        this.cd.detectChanges();
      },
      error: () => {
        // gdev totals are best-effort; the rest of the page still works.
        this.drawChart();
        this.cd.detectChanges();
      }
    });
  }

  private refreshFacets(): void {
    const users = new Set<string>();
    const branches = new Set<string>();
    const tags = new Set<string>();
    for (const s of this.startups) {
      if (s.ae.user) users.add(s.ae.user);
      if (s.ae.branch) branches.add(s.ae.branch);
      if (s.ae.latest_tag) tags.add(s.ae.latest_tag);
    }
    this.knownUsers = [...users].sort();
    this.knownBranches = [...branches].sort();
    this.knownLatestTags = [...tags].sort();
  }

  toggle(row: StartupRow): void {
    row.expanded = !row.expanded;
    if (row.expanded && !row.phases && !row.loadingPhases) {
      this.loadPhases(row);
    }
  }

  // Joins phase data from gdev-events-1 for the given AE doc.
  // Strategy: same user + ±45-min window around the AE doc's timestamp.
  private loadPhases(row: StartupRow): void {
    row.loadingPhases = true;
    const aeTs = new Date(row.ae['@timestamp']);
    const winStart = new Date(aeTs.getTime() - 45 * 60 * 1000).toISOString();
    const winEnd = new Date(aeTs.getTime() + 5 * 60 * 1000).toISOString();

    const filters: any[] = [
      { term: { user: row.ae.user } },
      { range: { '@timestamp': { gte: winStart, lte: winEnd } } }
    ];
    const body = {
      size: 50,
      sort: [{ '@timestamp': 'asc' }],
      query: { bool: { filter: filters } }
    };

    this.http.post<any>(`${ES_URL}/${INDEX_GDEV}/_search`, body).subscribe({
      next: (r) => {
        const hits = (r?.hits?.hits ?? []) as any[];
        const all: GdevPhase[] = hits
          .map((h: any) => {
            const s = h._source;
            const tag = s?.payload?.tag ?? s?.tag ?? '?';
            const durStr = s?.payload?.duration ?? s?.duration;
            const dur = typeof durStr === 'string' ? parseFloat(durStr) : Number(durStr);
            return {
              '@timestamp': s['@timestamp'],
              tag,
              duration_seconds: isFinite(dur) ? dur : 0
            };
          })
          // Only "real" phase tags — drop umbrella ones with unhelpful 'all'/'?' tags
          .filter(p => p.tag && p.tag !== 'all' && p.tag !== '?');
        // The window can catch the tail of the user's PREVIOUS startup (e.g.
        // two restarts within 45 min), which showed each tag twice. Keep only
        // the most recent occurrence per tag — the one belonging to the
        // startup this AE doc describes. ISO timestamps compare as strings.
        const latestByTag = new Map<string, GdevPhase>();
        for (const p of all) {
          const prev = latestByTag.get(p.tag);
          if (!prev || p['@timestamp'] > prev['@timestamp']) {
            latestByTag.set(p.tag, p);
          }
        }
        row.phases = [...latestByTag.values()]
          .sort((a, b) => a['@timestamp'].localeCompare(b['@timestamp']));
        row.loadingPhases = false;
        this.cd.detectChanges();
      },
      error: () => {
        row.phases = [];
        row.loadingPhases = false;
        this.cd.detectChanges();
      }
    });
  }

  sortedTomcat(row: StartupRow): NameDuration[] {
    return [...(row.ae.tomcat_metrics ?? [])].sort((a, b) => b.duration_ms - a.duration_ms);
  }

  // Returns true if the bean line carries a usable class. Entries with no
  // class (logged as "[null]") are measurement artifacts: their stopwatch in
  // PerformanceTrackingBeanPostProcessor was never stopped (the static stats
  // map is shared across Spring contexts, so the same bean name gets
  // overwritten between contexts and one stopwatch is left running until
  // logStatistics() reads it ≈ whole-startup time). Drop them — they are not
  // real per-bean costs. The proper fix is server-side (per-context maps).
  private hasUsableClass(b: SpringBean): boolean {
    const c = (b.class ?? '').trim().toLowerCase();
    return c !== '' && c !== 'null';
  }

  sortedBeans(row: StartupRow): SpringBean[] {
    // Appian boots multiple Spring contexts (webapp + one per plugin), so the
    // same bean can show up several times — once per context that wires it.
    // Drop class-less artifacts, then keep only the slowest instance per
    // (name, class).
    const slowest = new Map<string, SpringBean>();
    for (const b of row.ae.spring_beans ?? []) {
      if (!this.hasUsableClass(b)) {
        continue;
      }
      const key = `${b.name}|${b.class ?? ''}`;
      const prev = slowest.get(key);
      if (!prev || prev.duration_ms < b.duration_ms) {
        slowest.set(key, b);
      }
    }
    return [...slowest.values()].sort((a, b) => b.duration_ms - a.duration_ms);
  }

  fmt(ms: number | undefined): string {
    if (ms == null || !isFinite(ms)) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s - m * 60);
    return `${m}m ${rs}s`;
  }

  fmtSec(sec: number | undefined): string {
    if (sec == null || !isFinite(sec)) return '—';
    return this.fmt(sec * 1000);
  }

  fmtTs(ts: string): string {
    try {
      // gdev-events-1 stores timestamps WITHOUT a timezone suffix (e.g.
      // "2026-06-11T12:10:41") but they are UTC; without the "Z" the Date
      // constructor would parse them as local time and display them 2h off.
      // ae-startup-events-2 timestamps carry "+00:00" and are unaffected.
      const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(ts);
      const d = new Date(hasTz ? ts : ts + 'Z');
      return d.toLocaleString();
    } catch {
      return ts;
    }
  }

  private drawChart(): void {
    const canvas = document.getElementById('totalChart') as HTMLCanvasElement | null;
    if (!canvas) return;

    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    if (!this.startups.length) return;

    // group by branch
    const byBranch = new Map<string, { x: string; y: number }[]>();
    // iterate oldest → newest so chart's x-axis reads left-to-right
    [...this.startups].reverse().forEach(s => {
      if (s.kpiSeconds == null) return;
      const branch = s.ae.branch || 'unknown';
      if (!byBranch.has(branch)) byBranch.set(branch, []);
      byBranch.get(branch)!.push({ x: s.ae['@timestamp'], y: s.kpiSeconds });
    });

    const palette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
                     '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
    const datasets = [...byBranch.entries()].map(([branch, points], i) => ({
      label: branch,
      data: points,
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '33',
      tension: 0.2,
      pointRadius: 3
    }));

    this.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets } as any,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: { xAxisKey: 'x', yAxisKey: 'y' } as any,
        scales: {
          x: { type: 'time' as any, time: { unit: 'day' as any } } as any,
          y: { title: { display: true, text: 'gradle + webapp (s)' } }
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toFixed(1)} s`
            }
          }
        }
      }
    });
  }
}
