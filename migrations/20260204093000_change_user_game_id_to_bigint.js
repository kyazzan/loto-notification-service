exports.up = (pgm) => {
  pgm.alterColumn('devices', 'user_id', {
    type: 'bigint',
    using: 'user_id::bigint',
  });

  pgm.alterColumn('devices', 'game_id', {
    type: 'bigint',
    using: 'game_id::bigint',
  });
};

exports.down = (pgm) => {
  pgm.alterColumn('devices', 'user_id', {
    type: 'text',
    using: 'user_id::text',
  });

  pgm.alterColumn('devices', 'game_id', {
    type: 'text',
    using: 'game_id::text',
  });
};
