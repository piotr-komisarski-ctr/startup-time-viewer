import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

const ES_URL = 'https://vpc-dx-observer-prod-domain-kr4y2j7e4rfn527rrw734bgigq.us-east-1.es.amazonaws.com';
const INDEX = 'gdev-events-1';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  ready = false;
  activeTab = 'search';
  searchQuery = '';
  phases: { name: string; avgSec: number }[] = [];
  selectedPhase: string | null = null;
  history: any[] = [];
  loading = false;
  chart: Chart | null = null;
  avgDuration = '';
  minDuration = '';
  maxDuration = '';
  selectedDays = 90;
  dayOptions = [7, 30, 90];
  aggDays = 30;

  // Aggregate tab
  groups: AggGroup[] = [];
  aggLoading = false;

  private allPhases: { name: string; avgSec: number }[] = [];

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.http.post<any>(`${ES_URL}/${INDEX}/_search`, {
      size: 0,
      query: { exists: { field: 'payload.tag' } },
      aggs: {
        tags: {
          terms: { field: 'payload.tag.keyword', size: 500, order: { avg_dur: 'desc' } },
          aggs: { avg_dur: { avg: { field: 'payload.duration' } } }
        }
      }
    }).subscribe({
      next: (res) => {
        console.log('ES response:', res);
        console.log('Buckets:', res.aggregations?.tags?.buckets?.length);
        this.allPhases = (res.aggregations?.tags?.buckets || []).map((b: any) => ({
          name: b.key,
          avgSec: b.avg_dur.value
        }));
        console.log('allPhases loaded:', this.allPhases.length);
        this.ready = true;
        console.log('ready:', this.ready);
      },
      error: (err) => {
        console.error('ES error:', err);
        this.ready = true;
      }
    });
  }

  onSearch(query: string) {
    this.selectedPhase = null;
    if (query.length < 2) {
      this.phases = [];
      return;
    }
    const q = query.toLowerCase();
    this.phases = this.allPhases.filter(p => p.name.toLowerCase().includes(q));
  }

  selectPhase(phase: string) {
    this.selectedPhase = phase;
    this.loading = true;
    this.avgDuration = '';
    this.minDuration = '';
    this.maxDuration = '';
    const now = new Date().toISOString();
    const from = new Date(Date.now() - this.selectedDays * 24 * 60 * 60 * 1000).toISOString();
    this.http.post<any>(`${ES_URL}/${INDEX}/_search`, {
      size: 2000,
      sort: [{ '@timestamp': 'asc' }],
      query: {
        bool: {
          must: [
            { term: { 'payload.tag.keyword': phase } },
            { range: { '@timestamp': { gte: from, lte: now } } }
          ]
        }
      }
    }).subscribe(res => {
      this.history = (res.hits?.hits || []).map((h: any) => ({
        timestamp: h._source['@timestamp'],
        duration: parseFloat(h._source.payload?.duration || '0'),
        user: h._source.user,
        branch: h._source.origin?.contract?.baseline,
        event: h._source.payload?.event,
      }));
      this.loading = false;
      this.computeStats();
      this.cdr.detectChanges();
      requestAnimationFrame(() => this.renderChart());
    });
  }

  onDaysChange(days: number) {
    this.selectedDays = days;
    if (this.selectedPhase) {
      this.selectPhase(this.selectedPhase);
    }
  }

  clearSelection() {
    this.selectedPhase = null;
    if (this.chart) { this.chart.destroy(); this.chart = null; }
  }

  formatSec(sec: number): string {
    if (sec >= 60) return (sec / 60).toFixed(1) + ' min';
    return sec.toFixed(1) + 's';
  }

  private computeStats() {
    if (!this.history.length) return;
    try {
      const d = this.history.map((h: any) => Number(h.duration)).filter((v: number) => !isNaN(v) && v > 0);
      console.log('computeStats:', d.length, 'values, first 3:', d.slice(0,3));
      if (!d.length) return;
      const sum = d.reduce((a: number, b: number) => a + b, 0);
      let min = d[0], max = d[0];
      for (const v of d) { if (v < min) min = v; if (v > max) max = v; }
      this.avgDuration = this.formatSec(sum / d.length);
      this.minDuration = this.formatSec(min);
      this.maxDuration = this.formatSec(max);
      console.log('stats:', this.avgDuration, this.minDuration, this.maxDuration);
    } catch (e) {
      console.error('computeStats error:', e);
    }
  }

  private renderChart() {
    if (this.chart) this.chart.destroy();
    const canvas = document.getElementById('historyChart') as HTMLCanvasElement;
    if (!canvas) return;

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: this.history.map((h: any) =>
          new Date(h.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        ),
        datasets: [{
          label: 'Duration (seconds)',
          data: this.history.map((h: any) => h.duration),
          borderColor: '#4a90d9',
          backgroundColor: 'rgba(74, 144, 217, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }]
      },
      options: {
        responsive: true,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Seconds' } },
          x: { ticks: { maxRotation: 45, maxTicksLimit: 15 } }
        },
        plugins: {
          tooltip: {
            callbacks: {
              afterBody: (items: any) => {
                const idx = items[0]?.dataIndex;
                if (idx === undefined) return '';
                const hit = this.history[idx];
                const lines = [];
                if (hit.user) lines.push(`User: ${hit.user}`);
                if (hit.branch) lines.push(`Branch: ${hit.branch}`);
                if (hit.event) lines.push(`Event: ${hit.event}`);
                return lines.join('\n');
              }
            }
          }
        }
      }
    });
  }

  loadAggregateData() {
    this.aggLoading = true;
    const from = new Date(Date.now() - this.aggDays * 24 * 60 * 60 * 1000).toISOString();
    this.http.post<any>(`${ES_URL}/${INDEX}/_search`, {
      size: 0,
      query: {
        bool: {
          must: [
            { exists: { field: 'payload.tag' } },
            { range: { '@timestamp': { gte: from } } }
          ]
        }
      },
      aggs: {
        tags: {
          terms: { field: 'payload.tag.keyword', size: 500, order: { avg_dur: 'desc' } },
          aggs: {
            avg_dur: { avg: { field: 'payload.duration' } },
            min_dur: { min: { field: 'payload.duration' } },
            max_dur: { max: { field: 'payload.duration' } }
          }
        }
      }
    }).subscribe(res => {
      const buckets = (res.aggregations?.tags?.buckets || []);
      this.groups = this.buildGroups(buckets);
      this.aggLoading = false;
      this.cdr.detectChanges();
    });
  }

  onAggDaysChange(days: number) {
    this.aggDays = days;
    this.loadAggregateData();
  }

  toggleGroup(group: AggGroup) {
    group.expanded = !group.expanded;
  }

  private buildGroups(buckets: any[]): AggGroup[] {
    const toItem = (b: any): AggItem => ({
      tag: b.key, avg: b.avg_dur.value || 0, min: b.min_dur.value || 0,
      max: b.max_dur.value || 0, count: b.doc_count, subItems: [], expanded: false,
    });

    const matchExact = (tags: string[]) => buckets.filter(b => tags.includes(b.key)).map(toItem);
    const matchPrefix = (prefix: string) => buckets.filter(b => b.key.startsWith(prefix)).map(toItem);

    const makeGroup = (name: string, label: string, items: AggItem[]): AggGroup => {
      const avg = items.length ? items.reduce((s, i) => s + i.avg, 0) / items.length : 0;
      let min = 0, max = 0;
      if (items.length) {
        min = items[0].min; max = items[0].max;
        for (const i of items) { if (i.min < min) min = i.min; if (i.max > max) max = i.max; }
      }
      return { name, label, avg, min, max, items, expanded: false };
    };

    // D is special — has sub-groups
    const dTopItems = matchExact(['webapp-startup', 'webapp-svc-startup']);
    const dListeners = matchPrefix('webapp-').filter(i => !['webapp-startup', 'webapp-svc-startup'].includes(i.tag));
    const dBeans = matchPrefix('spring-bean-');

    if (dListeners.length) {
      const listenerGroup: AggItem = {
        tag: 'D.1 Listeners', avg: dListeners.reduce((s, i) => s + i.avg, 0) / dListeners.length,
        min: 0, max: 0, count: dListeners.reduce((s, i) => s + i.count, 0),
        subItems: dListeners.sort((a, b) => b.avg - a.avg), expanded: false,
      };
      dTopItems.push(listenerGroup);
    }
    if (dBeans.length) {
      const beanGroup: AggItem = {
        tag: `D.2 Spring Beans (${dBeans.length} beans)`,
        avg: dBeans.reduce((s, i) => s + i.avg, 0) / dBeans.length,
        min: 0, max: 0, count: dBeans.reduce((s, i) => s + i.count, 0),
        subItems: dBeans.sort((a, b) => b.avg - a.avg), expanded: false,
      };
      dTopItems.push(beanGroup);
    }

    return [
      makeGroup('A', 'Provisioning', []),
      makeGroup('B', 'Gradle Build', matchExact(['gradle-build', 'gradle-rebuild'])),
      makeGroup('C', 'Docker Build', matchExact(['docker-build', 'docker-rebuild'])),
      makeGroup('D', 'Webapp Startup', dTopItems),
      makeGroup('E', 'Daemons', matchExact(['sail-hot-deploy', 'sdx-server'])),
      makeGroup('F', 'TRex', matchExact(['trex-start', 'build-trex', 'start-trex'])),
    ];
  }

  toggleItem(item: AggItem) {
    item.expanded = !item.expanded;
  }
}

interface AggItem {
  tag: string;
  avg: number;
  min: number;
  max: number;
  count: number;
  subItems: AggItem[];
  expanded: boolean;
}

interface AggGroup {
  name: string;
  label: string;
  avg: number;
  min: number;
  max: number;
  items: AggItem[];
  expanded: boolean;
}
