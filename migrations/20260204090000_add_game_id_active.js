exports.up = (pgm) => {
  pgm.addColumn('devices', {
    game_id: { type: 'text', notNull: false },
    active: { type: 'boolean', notNull: true, default: false },
  });

  pgm.createIndex('devices', ['user_id', 'active']);
};

exports.down = (pgm) => {
  pgm.dropIndex('devices', ['user_id', 'active']);
  pgm.dropColumn('devices', ['game_id', 'active']);
};
