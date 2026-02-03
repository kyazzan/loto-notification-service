exports.up = (pgm) => {
  pgm.createTable('devices', {
    device_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: false },
    fcm_token: { type: 'text', notNull: true, unique: true },
    platform: { type: 'text', notNull: false },
    app_version: { type: 'text', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('devices', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('devices');
};
