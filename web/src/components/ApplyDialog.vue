<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  ApplyResult,
  ConfirmationProof,
  PreparedApply,
} from "../../../src/application/operations/apply.js";
import type { OperationEvent } from "../../../src/application/contracts.js";

const props = defineProps<{
  prepared: PreparedApply;
  events: OperationEvent[];
  executing: boolean;
  result: ApplyResult | null;
  error: { code: string; message: string } | null;
}>();
const emit = defineEmits<{ confirm: [proof: ConfirmationProof | undefined]; close: [] }>();

const environmentProof = ref("");
watch(
  () => props.prepared.id,
  () => (environmentProof.value = ""),
);

const proofValid = computed(
  () =>
    props.prepared.confirmation.type !== "environment" ||
    environmentProof.value === props.prepared.confirmation.environment,
);
const resourceFailure = computed(() => props.result?.value.resources.failed ?? null);
const permissionFailures = computed(() => props.result?.value.permissions.failed ?? []);
const applyIncomplete = computed(() => resourceFailure.value !== null || permissionFailures.value.length > 0);
const expiryTime = computed(() =>
  props.prepared.expiresAt === null
    ? null
    : new Date(props.prepared.expiresAt).toLocaleTimeString("de-DE"),
);

function confirm(): void {
  const requirement = props.prepared.confirmation;
  emit(
    "confirm",
    requirement.type === "environment"
      ? { type: "environment", value: environmentProof.value }
      : requirement.type === "yes"
        ? { type: "yes" }
        : undefined,
  );
}

function eventLabel(event: OperationEvent): string {
  if (event.type === "phase-started") {
    return (
      {
        backup: "Backup wird geschrieben",
        "apply-resources": "Ressourcen werden angewendet",
        "apply-permissions": "Berechtigungen werden angewendet",
        "post-apply": "Dynamische Gruppen werden aktualisiert",
      }[event.phase] ?? event.phase
    );
  }
  if (event.type === "backup-written") return "Backup geschrieben";
  if (event.type === "resource-created") return `${event.key} erstellt`;
  if (event.type === "resource-updated") return `${event.key} geändert`;
  if (event.type === "warning") return event.warning.message;
  if (event.type === "operation-completed") return "Apply abgeschlossen";
  if (event.type === "operation-failed") return `Apply fehlgeschlagen (${event.code})`;
  return event.type;
}
</script>

<template>
  <div class="dialog-backdrop" role="presentation" @click.self="!props.executing && $emit('close')">
    <section class="apply-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
      <header>
        <div>
          <p class="eyebrow">Vorbereiteter Apply</p>
          <h2 id="apply-title">{{ props.prepared.changeCount }} Änderungen bestätigen</h2>
        </div>
        <button
          class="dialog-close"
          :disabled="props.executing"
          aria-label="Schließen"
          @click="$emit('close')"
        >
          ×
        </button>
      </header>

      <template v-if="!props.result && !props.executing && !props.error">
        <p class="dialog-copy">
          Dieser Apply verwendet genau den gerade geprüften Plan. Vor der ersten Änderung erstellt ct ein
          Backup; die Bestätigungsregel stammt aus dem Core.
        </p>
        <div class="confirmation-card">
          <template v-if="props.prepared.confirmation.type === 'environment'">
            <strong>Geschütztes Environment</strong>
            <p>
              Gib <code>{{ props.prepared.confirmation.environment }}</code> ein, um das Ziel eindeutig zu
              bestätigen.
            </p>
            <input
              v-model="environmentProof"
              autocomplete="off"
              :placeholder="props.prepared.confirmation.environment"
            />
          </template>
          <template v-else>
            <strong>Apply freigeben</strong>
            <p>Die angezeigten Änderungen werden auf {{ props.prepared.plan.project.host }} angewendet.</p>
          </template>
        </div>
        <p v-if="expiryTime" class="expiry">Vorbereitung gültig bis {{ expiryTime }} Uhr.</p>
        <p v-else class="expiry">Vorbereitung ohne Zeitlimit gültig.</p>
        <div class="dialog-buttons">
          <button class="secondary" @click="$emit('close')">Abbrechen</button>
          <button class="danger-primary" :disabled="!proofValid" @click="confirm">Jetzt anwenden</button>
        </div>
      </template>

      <template v-else>
        <div v-if="props.error" class="dialog-error">
          <span>{{ props.error.code }}</span
          ><strong>{{ props.error.message }}</strong>
        </div>
        <div class="progress-list" aria-live="polite">
          <div v-for="(event, index) in props.events" :key="index" class="progress-event">
            <span :class="['progress-dot', { done: event.type !== 'operation-failed' }]">{{
              event.type === "operation-failed" ? "!" : "✓"
            }}</span>
            <span>{{ eventLabel(event) }}</span>
          </div>
          <div v-if="props.executing" class="progress-event active">
            <span class="spinner"></span><span>Apply läuft …</span>
          </div>
        </div>
        <div v-if="props.result && applyIncomplete" class="dialog-error apply-failure-result">
          <span>APPLY_INCOMPLETE</span>
          <strong>Der Apply konnte nicht alle Änderungen umsetzen.</strong>
          <p v-if="resourceFailure">
            Gestoppt bei <code>{{ resourceFailure.key }}</code
            >: {{ resourceFailure.message }}
          </p>
          <ul v-if="permissionFailures.length">
            <li
              v-for="failure in permissionFailures"
              :key="`${failure.method}:${failure.path}:${failure.authId}`"
            >
              <code>{{ failure.method }} {{ failure.path }}</code>
              (authId {{ failure.authId
              }}<template v-if="failure.dataId.length"> · dataId {{ failure.dataId.join(", ") }}</template
              >): {{ failure.message }}
            </li>
          </ul>
          <p>Der erreichte Zwischenstand wurde gespeichert. Der nächste Plan bleibt wiederholbar.</p>
        </div>
        <div v-else-if="props.result" class="apply-result">
          <strong>Apply abgeschlossen</strong>
          <p>
            {{ props.result.value.resources.created.length }} erstellt,
            {{ props.result.value.resources.updated.length }} geändert,
            {{ props.result.value.permissions.granted }} Rechte gesetzt,
            {{ props.result.value.permissions.deleted }} Rechte entfernt.
          </p>
        </div>
        <div class="dialog-buttons">
          <button v-if="!props.executing" class="primary" @click="$emit('close')">Zurück zum Plan</button>
        </div>
      </template>
    </section>
  </div>
</template>
