/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static source = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' };
  static id = { type: 'string', pattern: '^bk_[0-9a-z]{6,12}[0-9a-f]{16}$' };

  static sourceParams = { type: 'object', properties: { id: Schemas.source }, required: ['id'] };
  static idParams = { type: 'object', properties: { id: Schemas.id }, required: ['id'] };
  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      source: Schemas.source,
      status: { type: 'string', enum: ['running', 'ok', 'failed'] },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      cursor: { type: 'string', pattern: '^[0-9]{1,15}~bk_[0-9a-z]{6,12}[0-9a-f]{16}$' },
    },
  };
  static restore = {
    type: 'object', additionalProperties: false,
    properties: {
      target: { type: 'string', minLength: 1, maxLength: 128 },
      overwrite: { type: 'boolean' },
      live: { type: 'boolean' },
      confirm: { type: 'string', maxLength: 64 },
    },
  };
}
