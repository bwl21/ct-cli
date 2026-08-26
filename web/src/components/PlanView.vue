<script setup lang="ts">
import { ref } from "vue";
import type { PlanResult } from "../../../src/application/operations/plan.js";

const props = defineProps<{ plan: PlanResult | null; preparing: boolean }>();
defineEmits<{ apply: [] }>();

const expanded = ref(new Set<string>());

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function value(value: unknown): string {
  if (value === undefined) return "–";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
</script>

<template>
  <section class="panel table-panel plan-panel">
    <div class="panel-heading plan-heading">
      <div>
        <p class="eyebrow">Kanonisches Ergebnis</p>
        <h2>Geplante Änderungen</h2>
      </div>
      <div class="plan-actions">
        <span :class="['health-pill', props.plan?.value.complete ? 'healthy' : 'warning']">
          {{ props.plan?.value.complete ? "vollständig" : "unvollständig" }}
        </span>
        <button
          class="primary compact-button"
          :disabled="props.preparing || !props.plan?.value.complete || !props.plan?.value.summary.hasChanges"
          @click="$emit('apply')"
        >
          {{ props.preparing ? "Wird vorbereitet …" : "Apply vorbereiten" }}
        </button>
      </div>
    </div>

    <div v-if="props.plan" class="plan-summary-strip">
      <span
        ><b>{{ props.plan.value.summary.resources.create }}</b> erstellen</span
      >
      <span
        ><b>{{ props.plan.value.summary.resources.update }}</b> ändern</span
      >
      <span
        ><b>{{ props.plan.value.summary.resources.delete }}</b> löschen</span
      >
      <span
        ><b>{{ props.plan.value.summary.permissions.toPut }}</b> Rechte setzen</span
      >
      <span
        ><b>{{ props.plan.value.summary.drifted }}</b> Drift</span
      >
    </div>

    <div v-if="props.plan?.value.fetchErrors.length" class="inline-warning">
      Der Plan ist unvollständig. Apply bleibt gesperrt, bis alle Ressourcen gelesen werden konnten.
    </div>

    <div
      v-if="props.plan?.value.plan.items.some((item) => item.action !== 'no-op' || item.note)"
      class="plan-list"
    >
      <article
        v-for="item in props.plan.value.plan.items.filter(
          (candidate) => candidate.action !== 'no-op' || candidate.note,
        )"
        :key="`${item.type}:${item.key}`"
        class="plan-item"
      >
        <button class="plan-item-summary" @click="toggle(item.key)">
          <span :class="['action-badge', item.action]">{{ item.action }}</span>
          <span class="resource-title">
            <strong>{{ item.key }}</strong>
            <small>
              {{ item.type }}<template v-if="item.id !== null"> · #{{ item.id }}</template>
              <template v-if="item.note"> · {{ item.note }}</template>
            </small>
          </span>
          <span class="change-count">{{ item.changes.length }} Felder</span>
          <span :class="['chevron', { open: expanded.has(item.key) }]">⌄</span>
        </button>
        <div v-if="expanded.has(item.key)" class="change-table">
          <div class="change-row change-header">
            <span>Feld</span><span>ChurchTools</span><span>Gewünscht</span><span>Grund</span>
          </div>
          <div v-for="change in item.changes" :key="change.field" class="change-row">
            <code>{{ change.field }}</code>
            <code>{{ value(change.from) }}</code>
            <code>{{ value(change.to) }}</code>
            <span :class="['source-badge', change.source ?? 'config']">{{ change.source ?? "config" }}</span>
          </div>
          <p v-if="item.changes.length === 0" class="no-fields">Keine einzelnen Feldänderungen.</p>
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <strong>Keine Änderungen</strong>
      <p>Der gewünschte Zustand stimmt mit ChurchTools überein.</p>
    </div>
  </section>
</template>
