import { Repository } from '../src/db/repository.ts';

async function seed() {
  console.log('Seeding realistic demo reels...');

  const creatorsData = [
    {
      instagram_user_id: '101',
      username: 'tech_insider',
      display_name: 'Tech Insider',
      profile_picture_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    },
    {
      instagram_user_id: '102',
      username: 'design_daily',
      display_name: 'Design Daily & UI',
      profile_picture_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    },
    {
      instagram_user_id: '103',
      username: 'alex_code',
      display_name: 'Alex Developer',
      profile_picture_url: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150',
    },
    {
      instagram_user_id: '104',
      username: 'gourmet_chef',
      display_name: 'Chef Marco',
      profile_picture_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
    },
  ];

  const creators = [];
  for (const c of creatorsData) {
    creators.push(await Repository.upsertCreator(c));
  }

  const sampleReels = [
    {
      instagram_media_id: '30000000001',
      shortcode: 'C_demo_1',
      reel_url: 'https://www.instagram.com/reel/C_demo_1/',
      creator_id: creators[0].id,
      caption: 'The future of local AI agents and reverse engineering architecture in 2026! 🚀🤖 #ai #architecture',
      thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600',
      taken_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      first_detected_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      save_order_rank: 1,
      watch_status: 'unwatched' as const,
      duration_seconds: 45,
    },
    {
      instagram_media_id: '30000000002',
      shortcode: 'C_demo_2',
      reel_url: 'https://www.instagram.com/reel/C_demo_2/',
      creator_id: creators[1].id,
      caption: '5 glassmorphism UI micro-interactions that elevate your product design instantly. 🎨 #ui #ux #design',
      thumbnail_url: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600',
      taken_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      first_detected_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      save_order_rank: 2,
      watch_status: 'watch_later' as const,
      duration_seconds: 30,
    },
    {
      instagram_media_id: '30000000003',
      shortcode: 'C_demo_3',
      reel_url: 'https://www.instagram.com/reel/C_demo_3/',
      creator_id: creators[2].id,
      caption: 'Mastering distributed system design: how caching with Redis saves your database under heavy load 💻 #software #systemdesign',
      thumbnail_url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=600',
      taken_at: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      first_detected_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      save_order_rank: 3,
      watch_status: 'watched' as const,
      duration_seconds: 60,
    },
    {
      instagram_media_id: '30000000004',
      shortcode: 'C_demo_4',
      reel_url: 'https://www.instagram.com/p/C_demo_4/',
      media_type: 'post' as const,
      creator_id: creators[3].id,
      caption: 'Authentic 15-minute Neapolitan pizza sauce carousel & step-by-step recipe card 🍕 #food #recipe',
      thumbnail_url: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600',
      taken_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      first_detected_at: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
      save_order_rank: 4,
      watch_status: 'unwatched' as const,
      duration_seconds: null,
    },
    {
      instagram_media_id: '30000000005',
      shortcode: 'C_demo_5',
      reel_url: 'https://www.instagram.com/p/C_demo_5/',
      media_type: 'post' as const,
      creator_id: creators[0].id,
      caption: 'Why PostgreSQL + Supabase is becoming the default database choice for scalable modern applications in 2026! 🔥',
      thumbnail_url: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600',
      taken_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      first_detected_at: new Date(Date.now() - 75 * 24 * 60 * 60 * 1000).toISOString(),
      save_order_rank: 5,
      watch_status: 'unwatched' as const,
      duration_seconds: null,
    },
  ];

  for (const r of sampleReels) {
    await Repository.upsertSavedReel(r);
  }

  console.log('✅ Demo seed completed with 4 creators and 5 reels!');
}

seed().catch(console.error);
