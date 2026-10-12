import { sql, type RawBuilder } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { isUuid } from "../../lib/uuid.js";
import type { Claims } from "../auth/types.js";
import type { CustomersRepository } from "../customers/customers.service.js";
import { and, appendScope, resolve, type Predicate, type Visibility } from "../datascope/datascope.js";
import type { LeadsRepository } from "../leads/leads.service.js";
import { P, expandImplies } from "../permissions/permissions.js";
import { TimelineEvent, type TimelineEventRow, type TimelineService } from "../timeline/timeline.service.js";

export const EntityLead = "lead";
export const EntityCustomer = "customer";

/** Timeline rows mirroring a note use this provider with external_id = note id. */
const TIMELINE_PROVIDER = "calls";
const MAX_NOTE_LENGTH = 5000;
const HISTORY_LIMIT = 50;
const TOPIC_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface Contact {
  type: string;
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  employer: string;
  stageName: string | null;
  priority: string;
  ownerName: string | null;
  updatedAt: Date;
  pinned: boolean;
}

export interface ContactFilter {
  search: string;
  type: string;
  /** "", low, medium, high, urgent */
  priority: string;
  pinnedOnly: boolean;
  /** Whose pins to mark and sort first; set by the service from the caller. */
  userId?: string;
  limit: number;
}

export interface PinInput {
  entityType: string;
  entityId: string;
}

const PRIORITIES = new Set(["", "low", "medium", "high", "urgent"]);

/** The selected record, normalised across leads and customers (Go calls.Person field order). */
export interface Person {
  type: string;
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  employer: string;
  jobTitle: string;
  occupation: string;
  anzscoCode: string | null;
  anzscoTitle: string | null;
  qualification: string;
  experienceYears: number | null;
  skills: string[] | null;
  country: string;
  location: string;
  source: string;
  priority: string;
  status: string;
  pipelineName: string | null;
  stageName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  teamName: string | null;
  expectedOutcome: string;
  potentialValue: number | null;
  notes: string;
  lastContactAt: Date | null;
  nextFollowUpAt: Date | null;
  tags: string[] | null;
  createdAt: Date;
}

export interface DealSummary {
  id: string;
  title: string;
  status: string;
  stageName: string | null;
  value: number | null;
  currency: string;
  expectedCloseAt: string | null;
  lostReason: string;
}

export interface UpcomingActivity {
  id: string;
  title: string;
  kind: string;
  typeName: string | null;
  status: string;
  dueAt: Date | null;
}

export interface Interaction {
  eventType: string;
  title: string;
  body: string;
  occurredAt: Date;
  actorName: string | null;
}

export interface DocumentSummary {
  id: string;
  name: string;
  docType: string;
  status: string;
}

export interface CallContext {
  person: Person;
  deals: DealSummary[];
  upcoming: UpcomingActivity[];
  lastInteraction: Interaction | null;
  documents: DocumentSummary[];
}

export interface Note {
  id: string;
  leadId: string | null;
  customerId: string | null;
  topic: string;
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNoteInput {
  entityType: string;
  entityId: string;
  topic: string;
  content: string;
}

export interface UpdateNoteInput {
  topic: string | undefined;
  content: string | undefined;
}

/** Timeline types that represent contact with the person. */
const INTERACTION_EVENTS = [
  TimelineEvent.Call,
  TimelineEvent.WhatsApp,
  TimelineEvent.Email,
  TimelineEvent.Meeting,
  TimelineEvent.Note,
  TimelineEvent.ActivityCompleted,
];

const entityColumn = (entityType: string) => sql.raw(entityType === EntityCustomer ? "customer_id" : "lead_id");

/** Matches name, email, phone and employer; phone also matches on digits only. */
function contactSearch(alias: string, q: string): Predicate | null {
  q = q.trim();
  if (q === "") return null;
  const a = (col: string) => sql.raw(`${alias}.${col}`);
  const parts: Predicate[] = [
    sql`${a("full_name")} ILIKE '%'||${q}||'%'`,
    sql`COALESCE(${a("email")},'') ILIKE '%'||${q}||'%'`,
    sql`COALESCE(${a("phone")},'') ILIKE '%'||${q}||'%'`,
    sql`${a("employer")} ILIKE '%'||${q}||'%'`,
  ];
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3) {
    parts.push(sql`regexp_replace(COALESCE(${a("phone")},''),'\\D','','g') LIKE '%'||${digits}||'%'`);
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

const noteSelect = sql`
  SELECT n.id::text AS "id", n.lead_id::text AS "leadId", n.customer_id::text AS "customerId", n.topic, n.content,
    n.author_user_id::text AS "authorUserId", u.full_name AS "authorName", n.created_at AS "createdAt", n.updated_at AS "updatedAt"
  FROM conversation_notes n
  LEFT JOIN users u ON u.id = n.author_user_id`;

/** "Call note · Next steps" from a topic id. */
export function timelineTitle(topic: string): string {
  let label = topic.replaceAll("_", " ");
  if (label !== "") label = label.slice(0, 1).toUpperCase() + label.slice(1);
  return `Call note · ${label}`;
}

const timelineMeta = (noteId: string, topic: string) => JSON.stringify({ noteId, origin: "calls", topic });

export class CallsRepository {
  constructor(private readonly db: Database) {}

  /** Leads and customers the caller may see. A null visibility skips that entity type. */
  async contacts(f: ContactFilter, leadVis: Visibility | null, customerVis: Visibility | null): Promise<Contact[]> {
    const limit = f.limit <= 0 || f.limit > 100 ? 50 : f.limit;
    const parts: RawBuilder<unknown>[] = [];
    /** Adds the priority and pin conditions and returns the pinned expression. */
    const filters = (alias: string, entityType: string, where: Predicate[]): Predicate => {
      const a = (col: string) => sql.raw(`${alias}.${col}`);
      if (f.priority !== "") where.push(sql`${a("priority")} = ${f.priority}`);
      const pinned = sql`EXISTS (SELECT 1 FROM call_pins cp WHERE cp.user_id::text = ${f.userId ?? ""}
        AND cp.entity_type = ${sql.lit(entityType)} AND cp.entity_id = ${a("id")})`;
      if (f.pinnedOnly) where.push(pinned);
      return pinned;
    };
    if (leadVis && f.type !== EntityCustomer) {
      let where: Predicate[] = [sql`l.is_archived = FALSE`];
      const cond = contactSearch("l", f.search);
      if (cond) where.push(cond);
      const pinned = filters("l", EntityLead, where);
      where = appendScope(where, leadVis, { owner: "l.owner_user_id", team: "l.team_id" });
      parts.push(sql`
        SELECT 'lead' AS type, l.id::text AS id, l.full_name, l.email, l.phone, l.employer,
          ps.name AS stage_name, l.priority, ou.full_name AS owner_name, l.updated_at, ${pinned} AS pinned
        FROM leads l
        LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
        LEFT JOIN users ou ON ou.id = l.owner_user_id
        WHERE ${and(where)}`);
    }
    if (customerVis && f.type !== EntityLead) {
      let where: Predicate[] = [sql`c.is_archived = FALSE`];
      const cond = contactSearch("c", f.search);
      if (cond) where.push(cond);
      const pinned = filters("c", EntityCustomer, where);
      where = appendScope(where, customerVis, { owner: "c.owner_user_id", team: "c.team_id" });
      parts.push(sql`
        SELECT 'customer' AS type, c.id::text AS id, c.full_name, c.email, c.phone, c.employer,
          ps.name AS stage_name, c.priority, ou.full_name AS owner_name, c.updated_at, ${pinned} AS pinned
        FROM customers c
        LEFT JOIN pipeline_stages ps ON ps.id = c.stage_id
        LEFT JOIN users ou ON ou.id = c.owner_user_id
        WHERE ${and(where)}`);
    }
    if (parts.length === 0) return [];
    const r = await sql<Contact>`
      SELECT type, id, full_name AS "fullName", email, phone, employer, stage_name AS "stageName", priority,
        owner_name AS "ownerName", updated_at AS "updatedAt", pinned
      FROM (${sql.join(parts, sql` UNION ALL `)}) x
      ORDER BY pinned DESC, updated_at DESC, full_name ASC
      LIMIT ${limit}`.execute(this.db);
    return r.rows;
  }

  async pin(userId: string, entityType: string, entityId: string): Promise<void> {
    await sql`
      INSERT INTO call_pins (user_id, entity_type, entity_id) VALUES (${userId}, ${entityType}, ${entityId})
      ON CONFLICT DO NOTHING`.execute(this.db);
  }

  async unpin(userId: string, entityType: string, entityId: string): Promise<void> {
    await sql`
      DELETE FROM call_pins WHERE user_id = ${userId} AND entity_type = ${entityType} AND entity_id = ${entityId}`.execute(this.db);
  }

  /** Whether the record exists and falls inside the caller's visibility. */
  async inScope(entityType: string, id: string, vis: Visibility): Promise<boolean> {
    const customer = entityType === EntityCustomer;
    const alias = customer ? "c" : "l";
    const where = appendScope([sql`${sql.raw(alias)}.id = ${id}`], vis, {
      owner: `${alias}.owner_user_id`,
      team: `${alias}.team_id`,
    });
    const table = sql.raw(customer ? "customers c" : "leads l");
    const r = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${and(where)}) AS ok`.execute(this.db);
    return r.rows[0]?.ok ?? false;
  }

  async deals(customerId: string): Promise<DealSummary[]> {
    const r = await sql<DealSummary>`
      SELECT d.id::text AS "id", d.title, d.status, ps.name AS "stageName", d.value::float8 AS "value", d.currency,
        to_char(d.expected_close_at, 'YYYY-MM-DD') AS "expectedCloseAt", d.lost_reason AS "lostReason"
      FROM deals d
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      WHERE d.customer_id = ${customerId} AND d.status <> 'archived'
      ORDER BY (d.status = 'open') DESC, d.updated_at DESC
      LIMIT 10`.execute(this.db);
    return r.rows;
  }

  async upcoming(entityType: string, id: string): Promise<UpcomingActivity[]> {
    const r = await sql<UpcomingActivity>`
      SELECT a.id::text AS "id", COALESCE(NULLIF(a.title,''), a.subject) AS "title", a.kind, t.name AS "typeName", a.status,
        COALESCE(a.due_at, a.start_at) AS "dueAt"
      FROM activities a
      LEFT JOIN activity_types t ON t.id = a.activity_type_id
      WHERE a.${entityColumn(entityType)} = ${id} AND a.status IN ('upcoming','due','overdue')
      ORDER BY COALESCE(a.due_at, a.start_at) ASC NULLS LAST
      LIMIT 5`.execute(this.db);
    return r.rows;
  }

  async lastInteraction(entityType: string, id: string): Promise<Interaction | null> {
    const r = await sql<Interaction>`
      SELECT e.event_type AS "eventType", e.title, e.body, e.occurred_at AS "occurredAt", u.full_name AS "actorName"
      FROM timeline_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.${entityColumn(entityType)} = ${id} AND e.event_type = ANY(${INTERACTION_EVENTS}::text[])
      ORDER BY e.occurred_at DESC, e.created_at DESC
      LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async documents(entityType: string, id: string): Promise<DocumentSummary[]> {
    const r = await sql<DocumentSummary>`
      SELECT d.id::text AS "id", d.name, d.doc_type AS "docType", d.status
      FROM documents d
      WHERE d.${entityColumn(entityType)} = ${id}
      ORDER BY d.created_at DESC
      LIMIT 20`.execute(this.db);
    return r.rows;
  }

  async listNotes(entityType: string, id: string): Promise<Note[]> {
    const r = await sql<Note>`${noteSelect} WHERE n.${entityColumn(entityType)} = ${id} ORDER BY n.created_at DESC`.execute(this.db);
    return r.rows;
  }

  async getNote(id: string): Promise<Note | null> {
    const r = await sql<Note>`${noteSelect} WHERE n.id = ${id}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  /** Stores the note and its single timeline mirror in one transaction. */
  async createNote(entityType: string, entityId: string, topic: string, content: string, authorId: string): Promise<Note | null> {
    const col = entityColumn(entityType);
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await sql<{ id: string }>`
        INSERT INTO conversation_notes (${col}, topic, content, author_user_id)
        VALUES (${entityId}, ${topic}, ${content}, ${authorId})
        RETURNING id::text AS id`.execute(trx);
      const noteId = r.rows[0]!.id;
      await sql`
        INSERT INTO timeline_events (id, event_type, title, body, occurred_at, actor_user_id, source,
          external_id, external_provider, ${col}, metadata)
        VALUES (gen_random_uuid(), ${TimelineEvent.Note}, ${timelineTitle(topic)}, ${content}, NOW(), ${authorId}, 'crm',
          ${noteId}, ${TIMELINE_PROVIDER}, ${entityId}, ${timelineMeta(noteId, topic)}::jsonb)`.execute(trx);
      return noteId;
    });
    return this.getNote(id);
  }

  async updateNote(id: string, topic: string, content: string): Promise<Note | null> {
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE conversation_notes SET topic = ${topic}, content = ${content} WHERE id = ${id}`.execute(trx);
      await sql`
        UPDATE timeline_events SET title = ${timelineTitle(topic)}, body = ${content}, metadata = ${timelineMeta(id, topic)}::jsonb
        WHERE external_provider = ${TIMELINE_PROVIDER} AND external_id = ${id}`.execute(trx);
    });
    return this.getNote(id);
  }

  async deleteNote(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`DELETE FROM timeline_events WHERE external_provider = ${TIMELINE_PROVIDER} AND external_id = ${id}`.execute(trx);
      await sql`DELETE FROM conversation_notes WHERE id = ${id}`.execute(trx);
    });
  }
}

function viewPermission(entityType: string): string {
  if (entityType === EntityLead) return P.LeadsView;
  if (entityType === EntityCustomer) return P.CustomersView;
  throw AppError.validation("type must be lead or customer");
}

const hasPermission = (claims: Claims, code: string) => expandImplies(claims.permissions).has(code);

export function normaliseNote(topic: string, content: string): { topic: string; content: string } {
  topic = topic.trim();
  content = content.trim();
  if (!TOPIC_PATTERN.test(topic)) throw AppError.validation("choose a topic for this note");
  if (content === "") throw AppError.validation("write something before saving the note");
  if ([...content].length > MAX_NOTE_LENGTH) throw AppError.validation("notes can be up to 5000 characters");
  return { topic, content };
}

/** Dedupes by id and orders newest first; Go's sort.SliceStable keeps ties in input order. */
export function mergeEvents(a: TimelineEventRow[], b: TimelineEventRow[], limit: number): TimelineEventRow[] {
  const seen = new Set<string>();
  const out: TimelineEventRow[] = [];
  for (const e of [...a, ...b]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((x, y) => y.occurredAt.getTime() - x.occurredAt.getTime());
  return out.slice(0, limit);
}

/** Calls workspace: preparing for and recording a conversation with a lead or customer. */
export class CallsService {
  readonly repo: CallsRepository;

  constructor(
    db: Database,
    private readonly leads: LeadsRepository,
    private readonly customers: CustomersRepository,
    private readonly timeline: TimelineService,
  ) {
    this.repo = new CallsRepository(db);
  }

  /** Missing and out-of-scope records both 404 so the API does not reveal which records exist. */
  private async authorize(claims: Claims, entityType: string, id: string): Promise<void> {
    const perm = viewPermission(entityType);
    if (!isUuid(id)) throw AppError.validation("id must be a valid UUID");
    const vis = resolve(claims, perm, "");
    let ok: boolean;
    try {
      ok = await this.repo.inScope(entityType, id, vis);
    } catch (err) {
      throw AppError.internal("failed to check record access", err);
    }
    if (!ok) throw AppError.notFound(`${entityType} not found`);
  }

  async contacts(claims: Claims, f: ContactFilter): Promise<Contact[]> {
    if (f.type !== "" && f.type !== EntityLead && f.type !== EntityCustomer) {
      throw AppError.validation("type must be lead or customer");
    }
    if (!PRIORITIES.has(f.priority)) throw AppError.validation("priority must be low, medium, high or urgent");
    const leadVis = hasPermission(claims, P.LeadsView) ? resolve(claims, P.LeadsView, "") : null;
    const customerVis = hasPermission(claims, P.CustomersView) ? resolve(claims, P.CustomersView, "") : null;
    if (!leadVis && !customerVis) throw AppError.forbidden("insufficient permissions");
    try {
      return await this.repo.contacts({ ...f, userId: claims.userId }, leadVis, customerVis);
    } catch (err) {
      throw AppError.internal("failed to list contacts", err);
    }
  }

  /** Keeps a lead or customer the caller can see at the top of their Calls list. */
  async pin(claims: Claims, in_: PinInput): Promise<void> {
    await this.authorize(claims, in_.entityType, in_.entityId);
    try {
      await this.repo.pin(claims.userId, in_.entityType, in_.entityId);
    } catch (err) {
      throw AppError.internal("failed to pin contact", err);
    }
  }

  /** Removes one of the caller's own pins; it needs no record access. */
  async unpin(claims: Claims, entityType: string, id: string): Promise<void> {
    viewPermission(entityType);
    if (!isUuid(id)) throw AppError.validation("id must be a valid UUID");
    try {
      await this.repo.unpin(claims.userId, entityType, id);
    } catch (err) {
      throw AppError.internal("failed to unpin contact", err);
    }
  }

  async context(claims: Claims, entityType: string, id: string): Promise<CallContext> {
    await this.authorize(claims, entityType, id);
    const person = await this.person(entityType, id);
    const load = async <T>(message: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        throw AppError.internal(message, err);
      }
    };
    const deals = entityType === EntityCustomer ? await load("failed to load deals", () => this.repo.deals(id)) : [];
    const upcoming = await load("failed to load upcoming activities", () => this.repo.upcoming(entityType, id));
    const lastInteraction = await load("failed to load last interaction", () => this.repo.lastInteraction(entityType, id));
    const documents = await load("failed to load documents", () => this.repo.documents(entityType, id));
    return { person, deals, upcoming, lastInteraction, documents };
  }

  private async person(entityType: string, id: string): Promise<Person> {
    if (entityType === EntityLead) {
      let l;
      try {
        l = await this.leads.get(id);
      } catch (err) {
        throw AppError.internal("failed to load lead", err);
      }
      if (!l) throw AppError.notFound("lead not found");
      return {
        type: EntityLead, id: l.id, fullName: l.fullName, email: l.email, phone: l.phone,
        employer: l.employer, jobTitle: l.jobTitle, occupation: l.occupation,
        anzscoCode: l.anzscoCode, anzscoTitle: l.anzscoTitle, qualification: l.qualification,
        experienceYears: l.experienceYears, skills: l.skills, country: l.country, location: l.location,
        source: l.source, priority: l.priority, status: l.status,
        pipelineName: l.pipelineName, stageName: l.stageName,
        ownerUserId: l.ownerUserId, ownerName: l.ownerName, teamName: l.teamName,
        expectedOutcome: l.expectedOutcome, potentialValue: l.potentialValue, notes: l.notes,
        lastContactAt: l.lastActivityAt, nextFollowUpAt: l.nextActivityAt, tags: l.tags,
        createdAt: l.createdAt,
      };
    }
    let c;
    try {
      c = await this.customers.get(id);
    } catch (err) {
      throw AppError.internal("failed to load customer", err);
    }
    if (!c) throw AppError.notFound("customer not found");
    return {
      type: EntityCustomer, id: c.id, fullName: c.fullName, email: c.email, phone: c.phone,
      employer: c.employer, jobTitle: c.jobTitle, occupation: c.occupation,
      anzscoCode: c.anzscoCode, anzscoTitle: c.anzscoTitle, qualification: c.qualification,
      experienceYears: c.experienceYears, skills: c.skills, country: c.country, location: c.location,
      source: c.source, priority: c.priority, status: "",
      pipelineName: c.pipelineName, stageName: c.stageName,
      ownerUserId: c.ownerUserId, ownerName: c.ownerName, teamName: c.teamName,
      expectedOutcome: c.expectedOutcome, potentialValue: c.potentialValue, notes: c.notes,
      lastContactAt: c.lastContactedAt, nextFollowUpAt: c.nextFollowUpAt, tags: c.tags,
      createdAt: c.createdAt,
    };
  }

  /** The person's timeline, newest first; a converted customer includes the lead's earlier events. */
  async history(claims: Claims, entityType: string, id: string): Promise<TimelineEventRow[]> {
    await this.authorize(claims, entityType, id);
    const filter = { customerId: "", dealId: "", leadId: "", eventTypes: [], source: "", limit: HISTORY_LIMIT, offset: 0 };
    const { items } = await this.timeline.list(entityType === EntityLead ? { ...filter, leadId: id } : { ...filter, customerId: id });
    if (entityType !== EntityCustomer) return items;
    let c;
    try {
      c = await this.customers.get(id);
    } catch (err) {
      throw AppError.internal("failed to load customer", err);
    }
    if (!c?.convertedFromLeadId) return items;
    const earlier = await this.timeline.list({ ...filter, leadId: c.convertedFromLeadId });
    return mergeEvents(items, earlier.items, HISTORY_LIMIT);
  }

  async listNotes(claims: Claims, entityType: string, id: string): Promise<Note[]> {
    await this.authorize(claims, entityType, id);
    try {
      return await this.repo.listNotes(entityType, id);
    } catch (err) {
      throw AppError.internal("failed to list notes", err);
    }
  }

  async createNote(claims: Claims, in_: CreateNoteInput): Promise<Note | null> {
    if (!hasPermission(claims, P.ActivitiesCreate)) throw AppError.forbidden("insufficient permissions");
    const { topic, content } = normaliseNote(in_.topic, in_.content);
    await this.authorize(claims, in_.entityType, in_.entityId);
    try {
      return await this.repo.createNote(in_.entityType, in_.entityId, topic, content, claims.userId);
    } catch (err) {
      throw AppError.internal("failed to save note", err);
    }
  }

  /** A note the caller may modify: they must still see the record and be its author. */
  private async ownNote(claims: Claims, id: string): Promise<Note> {
    if (!hasPermission(claims, P.ActivitiesEdit)) throw AppError.forbidden("insufficient permissions");
    if (!isUuid(id)) throw AppError.validation("id must be a valid UUID");
    let n: Note | null;
    try {
      n = await this.repo.getNote(id);
    } catch (err) {
      throw AppError.internal("failed to load note", err);
    }
    if (!n) throw AppError.notFound("note not found");
    const [entityType, entityId] = n.leadId !== null ? [EntityLead, n.leadId] : n.customerId !== null ? [EntityCustomer, n.customerId] : ["", ""];
    try {
      await this.authorize(claims, entityType, entityId);
    } catch {
      throw AppError.notFound("note not found");
    }
    if (n.authorUserId === null || n.authorUserId !== claims.userId) {
      throw AppError.forbidden("you can only change notes you wrote");
    }
    return n;
  }

  async updateNote(claims: Claims, id: string, in_: UpdateNoteInput): Promise<Note | null> {
    const current = await this.ownNote(claims, id);
    const { topic, content } = normaliseNote(in_.topic ?? current.topic, in_.content ?? current.content);
    try {
      return await this.repo.updateNote(id, topic, content);
    } catch (err) {
      throw AppError.internal("failed to update note", err);
    }
  }

  async deleteNote(claims: Claims, id: string): Promise<void> {
    await this.ownNote(claims, id);
    try {
      await this.repo.deleteNote(id);
    } catch (err) {
      throw AppError.internal("failed to delete note", err);
    }
  }
}
