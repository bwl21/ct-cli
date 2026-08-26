<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AuthStatusResult } from "../../src/application/operations/auth.js";
import type {
  ApplyResult,
  ConfirmationProof,
  PreparedApply,
} from "../../src/application/operations/apply.js";
import type { CoverageResult } from "../../src/application/operations/coverage.js";
import type { PlanResult } from "../../src/application/operations/plan.js";
import type { StateListResult } from "../../src/application/operations/state.js";
import type { OperationEvent } from "../../src/application/contracts.js";
import ApplyDialog from "./components/ApplyDialog.vue";
import PlanView from "./components/PlanView.vue";
import { ApiError, api, establishSession, watchOperation } from "./api.js";

type View = "overview" | "plan" | "coverage" | "state";

const view = ref<View>("overview");
const environment = ref("");
const auth = ref<AuthStatusResult | null>(null);
const plan = ref<PlanResult | null>(null);
const coverage = ref<CoverageResult | null>(null);
const state = ref<StateListResult | null>(null);
const loading = ref<string | null>("Projekt wird verbunden");
const error = ref<{ code: string; message: string } | null>(null);
const preparingApply = ref(false);
const preparedApply = ref<PreparedApply | null>(null);
const applyExecuting = ref(false);
const applyEvents = ref<OperationEvent[]>([]);
const applyResult = ref<ApplyResult | null>(null);
const applyError = ref<{ code: string; message: string } | null>(null);

const request = computed(() => (environment.value ? { environment: environment.value } : {}));
const identity = computed(() => {
  const person = auth.value?.identity;
  if (!person) return "Nicht angemeldet";
  return [person.firstName, person.lastName].filter(Boolean).join(" ") || person.email || `#${person.id}`;
});
const project = computed(() => plan.value?.project ?? state.value?.project ?? null);

function showError(caught: unknown): void {
  error.value = {
    code: caught instanceof ApiError ? caught.code : "UNEXPECTED_ERROR",
    message: caught instanceof Error ? caught.message : String(caught),
  };
}

async function loadOverview(): Promise<void> {
  loading.value = "Projektstatus wird geladen";
  error.value = null;
  try {
    auth.value = await api.authStatus(request.value);
    if (!environment.value && auth.value.environment) environment.value = auth.value.environment;
    [plan.value, state.value] = await Promise.all([api.plan(request.value), api.state(request.value)]);
  } catch (caught) {
    showError(caught);
  } finally {
    loading.value = null;
  }
}

async function openCoverage(): Promise<void> {
  view.value = "coverage";
  if (coverage.value) return;
  loading.value = "Coverage wird ermittelt";
  error.value = null;
  try {
    coverage.value = await api.coverage(request.value);
  } catch (caught) {
    showError(caught);
  } finally {
    loading.value = null;
  }
}

async function switchEnvironment(): Promise<void> {
  plan.value = null;
  state.value = null;
  coverage.value = null;
  preparedApply.value = null;
  await loadOverview();
}

async function prepareCurrentApply(): Promise<void> {
  preparingApply.value = true;
  error.value = null;
  try {
    preparedApply.value = await api.prepareApply(request.value);
    plan.value = preparedApply.value.plan;
    applyEvents.value = [];
    applyResult.value = null;
    applyError.value = null;
  } catch (caught) {
    showError(caught);
  } finally {
    preparingApply.value = false;
  }
}

async function executeCurrentApply(proof?: ConfirmationProof): Promise<void> {
  const prepared = preparedApply.value;
  if (!prepared) return;
  applyExecuting.value = true;
  applyError.value = null;
  applyEvents.value = [];
  const stream = watchOperation(prepared.id, (event) => applyEvents.value.push(event));
  const progress = stream.finished.catch((caught: unknown) => {
    applyError.value = {
      code: "PROGRESS_INTERRUPTED",
      message: caught instanceof Error ? caught.message : String(caught),
    };
    return null;
  });
  try {
    applyResult.value = await api.executeApply(prepared.id, proof);
    await progress;
  } catch (caught) {
    await progress;
    applyError.value = {
      code: caught instanceof ApiError ? caught.code : "UNEXPECTED_ERROR",
      message: caught instanceof Error ? caught.message : String(caught),
    };
  } finally {
    stream.close();
    applyExecuting.value = false;
  }
}

async function closeApply(): Promise<void> {
  if (applyExecuting.value) return;
  const refresh = applyResult.value !== null;
  preparedApply.value = null;
  applyEvents.value = [];
  applyResult.value = null;
  applyError.value = null;
  if (refresh) await loadOverview();
}

onMounted(async () => {
  try {
    await establishSession();
    await loadOverview();
  } catch (caught) {
    showError(caught);
    loading.value = null;
  }
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="view = 'overview'">
        <span class="brand-mark">ct</span>
        <span><strong>ChurchTools</strong><small>als Code verwalten</small></span>
      </a>

      <nav aria-label="Hauptnavigation">
        <button :class="{ active: view === 'overview' }" @click="view = 'overview'">
          <span>Übersicht</span><kbd>1</kbd>
        </button>
        <button :class="{ active: view === 'plan' }" @click="view = 'plan'">
          <span>Plan</span><b v-if="plan?.value.summary.hasChanges" class="nav-dot"></b>
        </button>
        <button :class="{ active: view === 'coverage' }" @click="openCoverage">
          <span>Coverage</span>
        </button>
        <button :class="{ active: view === 'state' }" @click="view = 'state'">
          <span>State</span><small>{{ state?.value.resources.length ?? "–" }}</small>
        </button>
      </nav>

      <div class="sidebar-foot">
        <span :class="['status-light', auth?.authenticated ? 'online' : '']"></span>
        <span
          ><strong>{{ identity }}</strong
          ><small>{{ auth?.host ?? "Keine Instanz" }}</small></span
        >
      </div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">Lokaler Arbeitsbereich</p>
          <h1>{{ view === "overview" ? "Übersicht" : view === "state" ? "Managed State" : view }}</h1>
        </div>
        <form class="environment" @submit.prevent="switchEnvironment">
          <label for="environment">Environment</label>
          <input id="environment" v-model.trim="environment" placeholder="z. B. dev" />
          <button type="submit">Laden</button>
        </form>
      </header>

      <section v-if="error" class="error-panel" role="alert">
        <span>{{ error.code }}</span>
        <div>
          <strong>Die Ansicht konnte nicht geladen werden.</strong>
          <p>{{ error.message }}</p>
        </div>
        <button @click="loadOverview">Erneut versuchen</button>
      </section>

      <section v-if="loading" class="loading-panel" aria-live="polite">
        <span class="spinner"></span>{{ loading }} …
      </section>

      <template v-if="view === 'overview' && !loading">
        <section class="hero-card">
          <div>
            <p class="eyebrow">{{ project?.protected ? "Geschütztes Environment" : "Bereit zur Prüfung" }}</p>
            <h2>{{ project?.environment ?? "Standardprojekt" }}</h2>
            <p>{{ project?.host ?? auth?.host ?? "Host wird nach erfolgreicher Anmeldung angezeigt" }}</p>
          </div>
          <div :class="['health-pill', plan?.value.complete ? 'healthy' : 'warning']">
            <span></span>{{ plan?.value.complete ? "Plan vollständig" : "Prüfung erforderlich" }}
          </div>
        </section>

        <section class="metric-grid">
          <article>
            <small>Erstellen</small><strong>{{ plan?.value.summary.resources.create ?? "–" }}</strong
            ><span>neue Ressourcen</span>
          </article>
          <article>
            <small>Ändern</small><strong>{{ plan?.value.summary.resources.update ?? "–" }}</strong
            ><span>geplante Updates</span>
          </article>
          <article>
            <small>Drift</small><strong>{{ plan?.value.summary.drifted ?? "–" }}</strong
            ><span>manuelle Abweichungen</span>
          </article>
          <article>
            <small>Verwaltet</small><strong>{{ state?.value.resources.length ?? "–" }}</strong
            ><span>Einträge im State</span>
          </article>
        </section>

        <section class="split-grid">
          <article class="panel next-action">
            <p class="eyebrow">Nächster Schritt</p>
            <h3>{{ plan?.value.summary.hasChanges ? "Plan sorgfältig prüfen" : "Alles synchron" }}</h3>
            <p v-if="plan?.value.summary.hasChanges">
              Die Entscheidung bleibt bei dir. Erst die Planansicht zeigt jede Änderung, bevor ein Apply
              vorbereitet wird.
            </p>
            <p v-else>Config, State und ChurchTools stimmen für dieses Environment überein.</p>
            <button class="primary" @click="view = 'plan'">Plan öffnen <span>→</span></button>
          </article>
          <article class="panel paths">
            <p class="eyebrow">Projektbindung</p>
            <dl>
              <div>
                <dt>Config</dt>
                <dd>{{ project?.configDisplayPath ?? "–" }}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{{ project?.stateDisplayPath ?? "–" }}</dd>
              </div>
              <div>
                <dt>ChurchTools</dt>
                <dd>{{ plan?.value.churchToolsVersion ?? "–" }}</dd>
              </div>
            </dl>
          </article>
        </section>
      </template>

      <PlanView
        v-else-if="view === 'plan' && !loading"
        :plan="plan"
        :preparing="preparingApply"
        @apply="prepareCurrentApply"
      />

      <section v-else-if="view === 'coverage' && !loading" class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Bestandsaufnahme</p>
            <h2>Coverage</h2>
          </div>
        </div>
        <section class="metric-grid compact">
          <article>
            <small>Gruppen</small><strong>{{ coverage?.value.report.groups.total ?? "–" }}</strong
            ><span>auf der Instanz</span>
          </article>
          <article>
            <small>Verwaltet</small><strong>{{ coverage?.value.report.groups.managed ?? "–" }}</strong
            ><span>im State</span>
          </article>
          <article>
            <small>Deklarierbar</small><strong>{{ coverage?.value.report.grants.declarable ?? "–" }}</strong
            ><span>Rolleninstanzen</span>
          </article>
          <article>
            <small>Blockiert</small><strong>{{ coverage?.value.report.grants.blocked ?? "–" }}</strong
            ><span>noch nicht portabel</span>
          </article>
        </section>
        <div class="resource-list">
          <article v-for="type in coverage?.value.report.byType" :key="type.groupTypeId">
            <span class="type-icon">{{ type.name.slice(0, 2).toUpperCase() }}</span>
            <div>
              <strong>{{ type.name }}</strong
              ><small>Gruppentyp #{{ type.groupTypeId }}</small>
            </div>
            <span>{{ type.managed }} / {{ type.total }} verwaltet</span>
          </article>
        </div>
      </section>

      <section v-else-if="view === 'state' && !loading" class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Hostgebundener Snapshot</p>
            <h2>Verwaltete Ressourcen</h2>
          </div>
        </div>
        <div v-if="state?.value.resources.length" class="resource-list">
          <article v-for="resource in state.value.resources" :key="resource.key">
            <span class="type-icon">{{ resource.type.slice(0, 2).toUpperCase() }}</span>
            <div>
              <strong>{{ resource.key }}</strong
              ><small>{{ resource.type }}</small>
            </div>
            <span>#{{ resource.id }}</span>
          </article>
        </div>
        <div v-else class="empty-state">
          <strong>Leerer State</strong>
          <p>Für dieses Environment werden noch keine Ressourcen verwaltet.</p>
        </div>
      </section>
    </main>

    <ApplyDialog
      v-if="preparedApply"
      :prepared="preparedApply"
      :events="applyEvents"
      :executing="applyExecuting"
      :result="applyResult"
      :error="applyError"
      @confirm="executeCurrentApply"
      @close="closeApply"
    />
  </div>
</template>
